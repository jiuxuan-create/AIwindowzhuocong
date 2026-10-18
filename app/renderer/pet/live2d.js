/**
 * Live2D 适配层。
 *
 * 只暴露「状态 → 表现」的接口，不关心业务：谁调用它、什么时候调用由 pet.js 决定。
 * 参数映射针对 Cubism 4 通用参数名，Haru（Live2D 官方示例模型）已实测对齐；
 * 换成自己的模型时，参数名不同也不会报错，只是对应的表现会缺失。
 */

const { Live2DModel, config: live2dConfig } = window.PIXI.live2d;

// 模型里可能不存在的参数，写入前先探测一次
const PROBE_PARAMS = [
  'ParamMouthOpenY',
  'ParamMouthForm',
  'ParamEyeLOpen',
  'ParamEyeROpen',
  'ParamEyeLSmile',
  'ParamEyeRSmile',
  'ParamBrowLY',
  'ParamBrowRY',
  'ParamBrowLX',
  'ParamBrowRX',
  'ParamBrowLAngle',
  'ParamBrowRAngle',
  'ParamBrowLForm',
  'ParamBrowRForm',
  'ParamTere',
  'ParamTear',
  'ParamEyeBallForm',
  'ParamBreath',
  'ParamBodyAngleZ',
  'ParamAngleZ',
];

/** 情绪 → 表现。expr 用模型自带的命名表情，params 做连续的微调。 */
const PRESETS = {
  happy: { expr: 'F01', params: { ParamMouthForm: 1.6, ParamEyeLSmile: 0.35, ParamEyeRSmile: 0.35 } },
  excited: { expr: 'F05', params: { ParamBodyAngleZ: 4 } },
  content: { expr: 'F01', params: { ParamMouthForm: 0.9 } },
  calm: { expr: null, params: {} },
  sad: { expr: 'F08', params: { ParamEyeLOpen: 0.85, ParamEyeROpen: 0.85 } },
  anxious: { expr: 'F04', params: {} },
  angry: { expr: 'F03', params: {} },
  surprised: { expr: 'F06', params: {} },
  tired: { expr: 'F04', params: { ParamEyeLOpen: 0.35, ParamEyeROpen: 0.35, ParamBodyAngleZ: -3 } },
  shy: { expr: 'F07', params: { ParamTere: 1 } },
};

export class PetAvatar {
  constructor() {
    this.app = null;
    this.model = null;
    this.available = new Set();
    this.overrides = new Map();
    this.currentPreset = null;
    this.currentExpr = undefined;
    this.lipLevel = 0;
    this.lipOpen = 0;
    this.gaze = { x: 0, y: 0 };
    this.sway = { t: 0, amp: 1 };
    this.anchor = { x: 0.5, y: 1 };
    this._lastMotion = 0;
    this._idleTimer = null;
  }

  static get presets() {
    return PRESETS;
  }

  async create({ container, modelUrl, preserveDrawingBuffer = false }) {
    this.app = new PIXI.Application({
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      resizeTo: container,
      preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    container.appendChild(this.app.view);

    live2dConfig.logLevel = live2dConfig.LOG_LEVEL_WARNING;
    Live2DModel.registerTicker(PIXI.Ticker);

    this.model = await Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      motionPreload: 'IDLE',
    });

    this.app.stage.addChild(this.model);
    this.model.anchor.set(this.anchor.x, this.anchor.y);
    this.model.interactive = false;
    this.model.eventMode = 'none';

    this._probeParams();
    this._bindHooks();
    this.createdDpr = window.devicePixelRatio || 1;
    this.measureContentBox();
    this.layout({ source: 'create' });
    this.setPreset('calm');
    this.playIdle();

    // 空闲时随机换个待机动作，避免一直是同一个循环
    this._idleTimer = setInterval(() => {
      if (Math.random() < 0.5) this.playMotion('Idle');
    }, 45000);

    return this;
  }

  _probeParams() {
    const core = this.coreModel;
    if (!core) return;
    for (const id of PROBE_PARAMS) {
      const idx = core.getParameterIndex(id);
      if (idx !== undefined && idx >= 0) this.available.add(id);
    }
    this.paramCount = core.getParameterCount ? core.getParameterCount() : 0;
  }

  get coreModel() {
    return this.model && this.model.internalModel && this.model.internalModel.coreModel;
  }

  _bindHooks() {
    const im = this.model.internalModel;
    // 在模型最终更新前写入参数：此时动作、表情、物理都已算完，写入即生效
    im.on('beforeModelUpdate', () => this.applyOverrides());
  }

  /** 参数写入（带存在性检查，缺参数不报错） */
  set(id, value) {
    if (!this.available.has(id)) return false;
    try {
      this.coreModel.setParameterValueById(id, value);
      return true;
    } catch {
      return false;
    }
  }

  add(id, value) {
    if (!this.available.has(id)) return false;
    try {
      this.coreModel.addParameterValueById(id, value);
      return true;
    } catch {
      return false;
    }
  }

  applyOverrides() {
    // 口型：主驱动
    const mouth = this.lipOpen;
    this.set('ParamMouthOpenY', mouth);

    // 情绪微调（在动作/表情之后写，保证不被覆盖）
    for (const [id, v] of this.overrides) this.set(id, v);

    // 待机摆动：随呼吸上下浮动一点点，避免看起来像贴图
    const t = this.sway.t;
    this.add('ParamBodyAngleZ', Math.sin(t * 0.7) * 0.8 * this.sway.amp);
    this.add('ParamAngleZ', Math.sin(t * 0.5 + 1.1) * 0.6 * this.sway.amp);
  }

  /** 主循环调用：推进口型与摆动 */
  update(dtSec) {
    this.sway.t += dtSec;
    // 说话时口型跟音频，收尾做平滑，避免闪烁
    const target = this.lipLevel;
    this.lipOpen += (target - this.lipOpen) * Math.min(1, dtSec * 18);
    if (this.lipOpen < 0.004) this.lipOpen = 0;
  }

  setLipLevel(v) {
    this.lipLevel = Math.max(0, Math.min(1, v || 0));
  }

  /** 说话时的口型幅度可以再夸大一点 */
  setSpeaking(speaking) {
    this.speaking = Boolean(speaking);
    this.sway.amp = speaking ? 1.5 : 1;
  }

  setPreset(key) {
    const preset = PRESETS[key] || PRESETS.calm;
    if (this.currentPreset === key) return;
    this.currentPreset = key;
    this.overrides.clear();
    for (const [id, v] of Object.entries(preset.params || {})) {
      if (this.available.has(id)) this.overrides.set(id, v);
    }
    if (preset.expr) this.expression(preset.expr);
    else this.clearExpression();
  }

  expression(name) {
    if (!this.model) return;
    if (this.currentExpr === name) return;
    const defs = this.model.internalModel.settings.expressions || [];
    if (!defs.some((e) => e.Name === name || e.name === name)) return;
    this.currentExpr = name;
    try {
      this.model.expression(name);
    } catch (err) {
      console.warn('[live2d] 设置表情失败', name, err);
    }
  }

  clearExpression() {
    const em = this.model && this.model.internalModel.motionManager.expressionManager;
    if (em && em.resetExpression) {
      try {
        em.resetExpression();
      } catch {
        /* ignore */
      }
    }
    this.currentExpr = undefined;
  }

  playIdle() {
    this.playMotion('Idle');
  }

  playMotion(group, index) {
    if (!this.model) return false;
    const defs = this.model.internalModel.settings.motions || {};
    const key = Object.keys(defs).find((k) => k.toLowerCase() === String(group).toLowerCase());
    if (!key) return false;
    try {
      const p = this.model.motion(key, index);
      if (p && p.catch) p.catch(() => {});
      this._lastMotion = performance.now();
      return true;
    } catch (err) {
      console.warn('[live2d] 播放动作失败', group, err);
      return false;
    }
  }

  /** 命中判定：优先用模型自带的 HitArea，退化到包围盒 */
  hitTest(x, y) {
    if (!this.model) return false;
    try {
      const names = this.model.hitTest(x, y);
      if (names && names.length) return names;
    } catch {
      /* ignore */
    }
    const b = this.model.getBounds();
    const insetX = b.width * 0.16;
    const insetY = b.height * 0.06;
    const inside = x >= b.x + insetX && x <= b.x + b.width - insetX && y >= b.y + insetY && y <= b.y + b.height - insetY;
    return inside ? ['Bounds'] : [];
  }

  /** 视线跟随（传画布坐标） */
  focus(x, y) {
    if (!this.model) return;
    try {
      this.model.focus(x, y);
    } catch {
      /* 模型没有 focus 控制器时忽略 */
    }
  }

  /**
   * 量出角色在画布里的实际可视范围（相对比例 0~1）。
   *
   * 不同模型的画布留白差别很大（Haru 的画布是 2400x4500，角色只占中间一条），
   * 直接按画布缩放会把头和脚裁掉，所以先渲一张小图扫一遍 alpha。
   *
   * 实现上刻意不用 renderer.extract（它读的是当前帧缓冲，透明窗口下不可靠），
   * 而是自己建一张 RenderTexture 渲进去再 readPixels，全过程可控。
   * 结果强制对画布中心对称：既保证不裁到人，也不受 readPixels 自下而上的行序影响。
   */
  measureContentBox() {
    const im = this.model.internalModel;
    const mw = im.width;
    const mh = im.height;
    if (!mw || !mh) return null;

    const s0 = 512 / Math.max(mw, mh);
    const W = Math.max(16, Math.round(mw * s0));
    const H = Math.max(16, Math.round(mh * s0));
    const saved = {
      ax: this.model.anchor.x,
      ay: this.model.anchor.y,
      sx: this.model.scale.x,
      x: this.model.x,
      y: this.model.y,
    };

    let raw = null;
    let error = null;
    const renderer = this.app.renderer;
    let rt = null;

    try {
      this.model.anchor.set(0, 0);
      this.model.scale.set(s0);
      this.model.position.set(0, 0);

      rt = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
      renderer.render(this.model, { renderTexture: rt, clear: true });
      renderer.renderTexture.bind(rt);

      const gl = renderer.gl;
      const data = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, data);

      let x0 = W;
      let y0 = H;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W * 4;
        for (let x = 0; x < W; x++) {
          if (data[row + x * 4 + 3] > 48) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 > x0 && y1 > y0) {
        raw = { x0: x0 / W, y0: y0 / H, x1: (x1 + 1) / W, y1: (y1 + 1) / H };
      } else {
        error = '渲出来是空的';
      }
    } catch (err) {
      error = (err && err.message) || String(err);
    } finally {
      try {
        if (rt) rt.destroy(true);
      } catch {
        /* ignore */
      }
      this.model.anchor.set(saved.ax, saved.ay);
      this.model.scale.set(saved.sx);
      this.model.position.set(saved.x, saved.y);
    }

    const half = raw
      ? {
          x: Math.max(Math.abs(raw.x0 - 0.5), Math.abs(raw.x1 - 0.5)),
          y: Math.max(Math.abs(raw.y0 - 0.5), Math.abs(raw.y1 - 0.5)),
        }
      : { x: 0.2, y: 0.45 };

    this.content = {
      hx: Math.min(0.5, half.x * 1.02),
      hy: Math.min(0.5, half.y * 1.02),
      raw,
      error,
    };
    if (error) console.warn('[live2d] 内容范围测量失败，用保守留白代替：', error);
    return this.content;
  }

  /**
   * 让角色适配容器。
   *   height  —— 按高度铺满，水平居中（默认，最像「站在桌上」）
   *   contain —— 整个角色完整塞进窗口，可能留边
   *   cover   —— 铺满窗口，可能裁到角色
   *
   * topInset 是给对话气泡预留的顶部空白带，角色只在其下方排布，
   * 这样气泡弹出来不会糊在脸上。
   */
  layout(opts = {}) {
    if (!this.app || !this.model) return;
    const fit = opts.fit || this.fit || 'height';
    const zoom = opts.zoom || this.zoom || 1;
    const offsetX = opts.offsetX || this.offsetX || 0;
    const offsetY = opts.offsetY || this.offsetY || 0;
    const topInset = Math.max(0, opts.topInset != null ? opts.topInset : this.topInset || 0);
    this.fit = fit;
    this.zoom = zoom;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.topInset = topInset;

    const { width, height } = this.app.screen;
    const im = this.model.internalModel;
    const mw = im.width;
    const mh = im.height;
    if (!mw || !mh || !width || !height) return;

    const usable = Math.max(120, height - topInset);
    const box = this.content || { hx: 0.2, hy: 0.45 };
    const cw = box.hx * 2 * mw;
    const ch = box.hy * 2 * mh;
    const base =
      fit === 'cover'
        ? Math.max(width / cw, usable / ch)
        : fit === 'contain'
          ? Math.min(width / cw, usable / ch)
          : usable / ch;

    this.model.scale.set(base * zoom);
    this.model.anchor.set(0.5, 0.5);
    this.model.position.set(width / 2 + offsetX, topInset + usable / 2 + offsetY);

    // 留一份最近一次布局的输入与结果，排障时能一眼看出缩放是被什么带偏的
    this.layoutCount = (this.layoutCount || 0) + 1;
    this.lastLayout = {
      source: opts.source || 'unknown',
      count: this.layoutCount,
      screen: { w: width, h: height },
      contentBox: { hx: box.hx, hy: box.hy, error: box.error || null },
      modelCanvas: { w: mw, h: mh },
      fit,
      zoom,
      topInset,
      usable,
      cw,
      ch,
      base,
      scale: this.model.scale.x,
      dprAtCreate: this.createdDpr,
      dprNow: window.devicePixelRatio || 1,
    };
  }

  setFit(opts) {
    this.layout({ ...opts, source: 'setFit' });
  }

  resize() {
    if (!this.app) return;
    const el = this.app.view.parentElement;
    if (el) this.app.renderer.resize(el.clientWidth || 0, el.clientHeight || 0);
    this.layout({ source: 'resize' });
  }

  destroy() {
    clearInterval(this._idleTimer);
    try {
      this.model && this.model.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.app && this.app.destroy(true, { children: true });
    } catch {
      /* ignore */
    }
    this.model = null;
    this.app = null;
  }
}

export { PRESETS };
