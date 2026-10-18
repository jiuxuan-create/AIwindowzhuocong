'use strict';
/**
 * 桌宠窗口。
 *
 * 关键点：
 * - 透明 + 无边框 + 置顶 + 不进任务栏；
 * - 用「forward 式点击穿透」实现只有角色本体可点，其它区域鼠标事件透到桌面；
 *   渲染端根据指针是否落在模型包围盒里，回调 setInteractive 切换。
 * - 位置/缩放/显示器都持久化，多屏拔插后会把窗口夹回可见区域。
 */
const path = require('node:path');
const { BrowserWindow, screen, shell } = require('electron');
const { url } = require('../protocol');
const { scoped } = require('../../core/logger');

const log = scoped('petWindow');

// 基准窗口尺寸：竖长条，给 Live2D 全身留高度，同时保证气泡宽度够用
const BASE_WIDTH = 340;
const BASE_HEIGHT = 660;

/**
 * DIP 坐标的物理像素步长。
 *
 * 显示器缩放不是整数时（150% → 1.5），1 个 DIP = 1.5 个物理像素，
 * 于是「宽度是奇数 DIP」或「坐标是奇数 DIP」的窗口都没法落在物理像素网格上。
 * 这种窗口每被移动一次，系统就要做一次取整，并且会把取整的零头补进尺寸里——
 * 表现就是「拖着走几步，桌宠就胖一圈」，一路从 340x660 长到 494x926。
 * 返回步长 s，使 s × 缩放因子 为整数；把尺寸和坐标都对齐到 s 的整数倍，
 * 系统就没有任何东西需要取整，尺寸也就不会再漂。
 */
function gridStep(scaleFactor) {
  const sf = Number(scaleFactor) || 1;
  if (Math.abs(sf - Math.round(sf)) < 1e-6) return 1;
  for (let i = 1; i <= 16; i++) {
    if (Math.abs(sf * i - Math.round(sf * i)) < 1e-6) return i;
  }
  return 1;
}

function snapTo(value, step) {
  return Math.round(value / step) * step;
}

function clampToDisplay(bounds, display) {
  const step = gridStep(display.scaleFactor);
  const wa = display.workArea;
  const w = Math.min(snapTo(bounds.width, step), snapTo(wa.width, step));
  const h = Math.min(snapTo(bounds.height, step), snapTo(wa.height, step));
  const maxX = snapTo(wa.x + wa.width - w, step);
  const maxY = snapTo(wa.y + wa.height - h, step);
  return {
    width: w,
    height: h,
    x: snapTo(Math.min(Math.max(bounds.x, wa.x), maxX), step),
    y: snapTo(Math.min(Math.max(bounds.y, wa.y), maxY), step),
  };
}

function defaultBounds(config) {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const scale = config.get('pet.scale', 1) || 1;
  const width = Math.round(BASE_WIDTH * scale);
  const height = Math.round(BASE_HEIGHT * scale);
  return clampToDisplay(
    { width, height, x: wa.x + wa.width - width - 24, y: wa.y + wa.height - height - 24 },
    display
  );
}

class PetWindow {
  constructor(config) {
    this.config = config;
    this.win = null;
    this.interactive = true;
    this.passthrough = false;
  }

  get webContents() {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  create() {
    const cfg = this.config.all();
    const saved = cfg.pet.position;
    let bounds;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const display = screen.getDisplayMatching({
        x: Math.round(saved.x),
        y: Math.round(saved.y),
        width: 10,
        height: 10,
      });
      const scale = cfg.pet.scale || 1;
      bounds = clampToDisplay(
        {
          width: Math.round(BASE_WIDTH * scale),
          height: Math.round(BASE_HEIGHT * scale),
          x: saved.x,
          y: saved.y,
        },
        display
      );
    } else {
      bounds = defaultBounds(this.config);
    }

    this.win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: cfg.pet.alwaysOnTop !== false,
      acceptFirstMouse: true,
      title: cfg.pet.name || '桌宠',
      icon: path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'renderer', 'pet', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        webSecurity: true,
      },
    });

    if (cfg.pet.alwaysOnTop !== false) this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setFullScreenable(false);
    this.lockSize();

    this.win.loadURL(url('renderer/pet/index.html'));

    this.win.once('ready-to-show', () => {
      this.win.show();
      this.applyClickThrough();
      log.info('桌宠窗口已显示');
    });

    // 保存位置（拖动结束/移动后节流保存）
    let moveTimer = null;
    this.win.on('moved', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => this.savePosition(), 400);
    });

    // 尺寸决定角色看起来多大，必须只有一个权威来源。
    //
    // Windows 上给无边框透明窗口调用 setIgnoreMouseEvents（点击穿透）时，
    // 系统会按「窗口矩形」重算一次尺寸，每次让窗口长 1px 并挪一点位置。
    // 而拖动时指针会在模型边缘反复进出，穿透开关就跟着反复切换，
    // 于是「拖一下，桌宠就越来越大」——所以这里盯着 resize：
    // 只要尺寸和期望值不一致，立刻按期望值掰回来。
    log.debug('窗口初始 bounds ' + JSON.stringify(bounds));
    this.win.on('resize', () => this.enforceSize());

    this.win.on('closed', () => {
      this.win = null;
    });

    // 外部链接交给系统浏览器
    this.win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https?:/.test(u)) shell.openExternal(u);
      return { action: 'deny' };
    });

    return this.win;
  }

  /** 窗口应该有多大：基准尺寸 × 配置缩放，再按所在显示器工作区夹一下 */
  desiredSize() {
    const scale = Math.max(0.35, Math.min(2.5, Number(this.config.get('pet.scale', 1)) || 1));
    let x = 0;
    let y = 0;
    if (this.win && !this.win.isDestroyed()) [x, y] = this.win.getPosition();
    const display = screen.getDisplayMatching({ x, y, width: 10, height: 10 });
    const b = clampToDisplay(
      { width: Math.round(BASE_WIDTH * scale), height: Math.round(BASE_HEIGHT * scale), x, y },
      display
    );
    return { width: b.width, height: b.height };
  }

  /** 当前窗口所在显示器的 DIP 坐标步长 */
  gridStep() {
    let x = 0;
    let y = 0;
    if (this.win && !this.win.isDestroyed()) [x, y] = this.win.getPosition();
    const display = screen.getDisplayMatching({ x, y, width: 10, height: 10 });
    return gridStep(display.scaleFactor);
  }

  /**
   * 把窗口位置对齐到物理像素网格。
   * 拖动时客户端给的坐标是任意整数，直接 setPosition 会让系统每次都取整，
   * 取整的零头会一路加到窗口宽度上——这就是「越拖越大」的来源。
   */
  snapPosition(x, y) {
    const step = this.gridStep();
    return { x: snapTo(x, step), y: snapTo(y, step) };
  }

  /**
   * 把「最小尺寸 = 最大尺寸 = 期望尺寸」写进窗口，让系统自己就没得改。
   * 这是第二道锁：即使某次移动真的让系统算出了别的尺寸，也会被夹回来。
   */
  lockSize() {
    if (!this.win || this.win.isDestroyed()) return;
    const { width, height } = this.desiredSize();
    this.win.setMinimumSize(width, height);
    this.win.setMaximumSize(width, height);
  }

  /**
   * 兜底：万一尺寸还是被改了，按期望值掰回来（位置对齐网格）。
   * 纠正动作本身会再触发一次 resize，所以用 _pinning 防止自己递归。
   */
  enforceSize() {
    if (this._pinning) return;
    if (!this.win || this.win.isDestroyed()) return;
    const want = this.desiredSize();
    const b = this.win.getBounds();
    if (b.width === want.width && b.height === want.height) return;
    this._pinning = true;
    try {
      const p = this.snapPosition(b.x, b.y);
      this.win.setBounds({ x: p.x, y: p.y, width: want.width, height: want.height });
      log.debug(`纠正窗口尺寸 ${b.width}x${b.height} → ${want.width}x${want.height}`);
    } catch (err) {
      log.warn('纠正窗口尺寸失败', err.message);
    } finally {
      this._pinning = false;
    }
  }

  savePosition() {
    if (!this.win || this.win.isDestroyed()) return;
    const [x, y] = this.win.getPosition();
    log.debug('保存位置 ' + x + ',' + y);
    this.config.set('pet.position', { x, y });
  }

  /** 只有落在角色身上的区域可交互，其余区域让鼠标穿到桌面 */
  setInteractive(v) {
    if (this.interactive === v) return;
    this.interactive = v;
    this.applyClickThrough();
  }

  applyClickThrough() {
    if (!this.win || this.win.isDestroyed()) return;
    const force = this.config.get('pet.clickThrough', false);
    const ignore = force || !this.interactive;
    try {
      this.win.setIgnoreMouseEvents(ignore, { forward: true });
      log.debug('设置鼠标穿透 ' + ignore + ' bounds ' + JSON.stringify(this.win.getBounds()));
    } catch (err) {
      log.warn('设置鼠标穿透失败', err.message);
    }
  }

  refreshClickThrough() {
    this.applyClickThrough();
  }

  setScale(scale) {
    const s = Math.max(0.35, Math.min(2.5, Number(scale) || 1));
    this.config.set('pet.scale', s);
    if (!this.win || this.win.isDestroyed()) return;
    const [x, y] = this.win.getPosition();
    const display = screen.getDisplayMatching({ x, y, width: 10, height: 10 });
    const b = clampToDisplay(
      { width: Math.round(BASE_WIDTH * s), height: Math.round(BASE_HEIGHT * s), x, y },
      display
    );
    this.lockSize();
    this.win.setBounds(b);
    log.debug('setScale ' + s + ' → bounds ' + JSON.stringify(this.win.getBounds()));
    this.savePosition();
  }

  setAlwaysOnTop(v) {
    this.config.set('pet.alwaysOnTop', Boolean(v));
    if (this.win && !this.win.isDestroyed()) {
      this.win.setAlwaysOnTop(Boolean(v), 'screen-saver');
    }
  }

  setOpacity(v) {
    const o = Math.max(0.15, Math.min(1, Number(v) || 1));
    this.config.set('pet.opacity', o);
    if (this.win && !this.win.isDestroyed()) this.win.setOpacity(o);
  }

  show() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
      this.win.setAlwaysOnTop(this.config.get('pet.alwaysOnTop', true), 'screen-saver');
    } else {
      this.create();
    }
  }

  hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  toggle() {
    if (!this.win || this.win.isDestroyed()) return this.create();
    if (this.win.isVisible()) this.hide();
    else this.show();
    return this.win;
  }

  resetPosition() {
    this.config.set('pet.position', null);
    if (!this.win || this.win.isDestroyed()) return;
    this.lockSize();
    this.win.setBounds(defaultBounds(this.config));
  }

  send(channel, payload) {
    const wc = this.webContents;
    if (wc) wc.send(channel, payload);
  }

  reload() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.reload();
  }
}

module.exports = { PetWindow, BASE_WIDTH, BASE_HEIGHT };
