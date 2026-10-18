/**
 * 桌宠渲染进程主逻辑。
 *
 * 只做三件事：
 *   1. 把主进程推来的状态翻译成 Live2D 表现（情绪、说话、动作）；
 *   2. 把用户的鼠标/键盘/麦克风输入翻译成主进程能懂的消息；
 *   3. 维护「哪儿能点到它」的判定，其余区域让鼠标穿到桌面。
 */
import { PetAvatar } from './live2d.js';
import { VoicePlayer } from './player.js';
import { MicCapture } from './audio.js';
import { FaceEmotion } from './camera.js';

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'),
  bubble: $('bubble'),
  bubbleName: $('bubbleName'),
  bubbleTag: $('bubbleTag'),
  bubbleText: $('bubbleText'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  micBtn: $('micBtn'),
  consoleBtn: $('consoleBtn'),
  status: $('status'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  hint: $('hint'),
};

const state = {
  config: null,
  emotion: null,
  avatar: null,
  player: null,
  mic: null,
  camera: null,
  ready: false,
  interactive: null,
  bubbleTimer: null,
  hintTimer: null,
  busy: false,
  speaking: false,
  composing: false,
  lastVisualAt: 0,
  pointer: { x: 0, y: 0, inside: false },
  drag: null,
};

// ------------------------------------------------------------------ 工具

function log(level, msg) {
  try {
    window.pet.log(level, msg);
  } catch {
    /* ignore */
  }
  if (level === 'error') console.error('[pet]', msg);
}

function showBubble(text, { tag = '', timeout } = {}) {
  const cfg = state.config || {};
  const max = cfg.pet?.bubbleMaxChars || 220;
  const body = String(text || '').slice(0, max * 2);
  el.bubbleText.textContent = body;
  el.bubbleTag.textContent = tag;
  el.bubble.hidden = false;
  clearTimeout(state.bubbleTimer);
  const ms = timeout ?? cfg.pet?.bubbleTimeoutMs ?? 10000;
  if (ms > 0) {
    state.bubbleTimer = setTimeout(() => {
      el.bubble.hidden = true;
    }, ms);
  }
}

function hideBubble() {
  clearTimeout(state.bubbleTimer);
  el.bubble.hidden = true;
}

function showHint(text, { warn = false, ms = 5000 } = {}) {
  el.hint.textContent = text;
  el.hint.classList.toggle('warn', warn);
  el.hint.hidden = false;
  clearTimeout(state.hintTimer);
  if (ms > 0) state.hintTimer = setTimeout(() => (el.hint.hidden = true), ms);
}

function setStatus(text, kind = '') {
  if (!text) {
    el.status.hidden = true;
    return;
  }
  el.status.hidden = false;
  el.statusText.textContent = text;
  el.statusDot.className = 'dot' + (kind ? ' ' + kind : '');
}

function setInteractive(v) {
  if (state.interactive === v) return;
  state.interactive = v;
  window.pet.setInteractive(v);
}

// ------------------------------------------------------------------ 情绪

function applyEmotion(snapshot) {
  if (!snapshot) return;
  state.emotion = snapshot;
  if (!state.avatar) return;
  const key = snapshot.expression || 'calm';
  state.avatar.setPreset(key);
}

// ------------------------------------------------------------------ 口型

function startFrameLoop() {
  let last = performance.now();
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (state.avatar) {
      const level = state.player ? state.player.currentLevel : 0;
      state.avatar.setLipLevel(level);
      state.avatar.update(dt);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ 语音

async function enableMic(on) {
  try {
    if (on) {
      if (!state.mic) state.mic = new MicCapture();
      state.mic.setVad(state.config?.voice?.vad || {});
      state.mic.addEventListener('utterance', onUtterance);
      state.mic.addEventListener('level', onMicLevel);
      await state.mic.start();
      el.micBtn.classList.add('on');
      setStatus('在听', 'listen');
    } else {
      if (state.mic) {
        state.mic.removeEventListener('utterance', onUtterance);
        state.mic.removeEventListener('level', onMicLevel);
        state.mic.stop();
        state.mic = null;
      }
      el.micBtn.classList.remove('on');
      setStatus('');
    }
  } catch (err) {
    log('error', '麦克风开启失败 ' + err.message);
    showHint('打不开麦克风：' + err.message, { warn: true });
    el.micBtn.classList.remove('on');
    setStatus('');
  }
}

function onMicLevel(e) {
  // 采集时的实时电平可以作为口型的最小驱动（用户说话时嘴也动）
  if (!state.speaking && state.avatar && e.detail) {
    const db = e.detail.db;
    const v = Math.max(0, Math.min(0.5, (db + 55) / 60));
    state.player = state.player || new VoicePlayer();
    // 不覆盖播放电平，只在没有播放时给一点反应
    if (!state.player.playing) state.avatar.setLipLevel(v * 0.8);
  }
}

function onUtterance(e) {
  const { samples, features } = e.detail;
  if (!samples || samples.length < 1600) return;
  setStatus('识别中…', 'busy');
  window.pet
    .voiceUtterance(Array.from(samples), features)
    .catch((err) => log('error', '上传语音失败 ' + err.message));
}

async function speak(text) {
  return window.pet.tts(text);
}

// ------------------------------------------------------------------ 发送

async function sendText(text) {
  const t = String(text || '').trim();
  if (!t || state.busy) return;
  state.busy = true;
  hideBubble();
  showBubble('…', { tag: '正在想', timeout: 0 });

  const signals = {};
  if (state.camera && state.camera.ready) {
    const bs = state.camera.sample();
    if (bs) signals.visual = bs;
  }

  try {
    const res = await window.pet.send(t, signals);
    if (res && res.error) {
      showHint('模型调用失败：' + res.error, { warn: true });
    }
    if (res && res.reply) {
      showBubble(res.reply, {
        tag: res.usedModel ? (res.model || '') : '本地模式',
      });
    }
  } catch (err) {
    log('error', '对话失败 ' + err.message);
    showHint('出错了：' + err.message, { warn: true });
  } finally {
    state.busy = false;
    setStatus('');
  }
}

// ------------------------------------------------------------------ 输入条

function showComposer(focus = true) {
  el.composer.hidden = false;
  state.composing = true;
  setInteractive(true);
  if (focus) setTimeout(() => el.input.focus(), 10);
}

function hideComposer() {
  el.composer.hidden = true;
  state.composing = false;
  el.input.blur();
}

el.sendBtn.addEventListener('click', () => {
  const t = el.input.value;
  el.input.value = '';
  sendText(t);
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    const t = el.input.value;
    el.input.value = '';
    sendText(t);
  } else if (e.key === 'Escape') {
    hideComposer();
  }
});

el.micBtn.addEventListener('click', async () => {
  const on = !(state.config?.voice?.wake?.enabled);
  await window.pet.voiceSetEnabled(on);
});

el.consoleBtn.addEventListener('click', () => window.pet.openConsole());

// ------------------------------------------------------------------ 交互

function pointOnUi(x, y) {
  const e = document.elementFromPoint(x, y);
  if (!e) return false;
  return Boolean(e.closest('#composer') || e.closest('.bubble') || e.closest('#hint'));
}

function updateInteractive(x, y) {
  if (!state.ready) return;
  if (state.composing) return setInteractive(true);
  if (pointOnUi(x, y)) return setInteractive(true);
  const names = state.avatar ? state.avatar.hitTest(x, y) : [];
  setInteractive(Boolean(names && names.length));
}

window.addEventListener(
  'mousemove',
  (e) => {
    state.__counts = state.__counts || { down: 0, move: 0, up: 0 };
    state.__counts.move++;
    state.pointer = { x: e.clientX, y: e.clientY, inside: true };
    if (state.drag) {
      window.pet.dragMove(e.screenX, e.screenY);
      return;
    }
    updateInteractive(e.clientX, e.clientY);
    if (state.config?.pet?.lookAtMouse !== false && state.avatar) {
      state.avatar.focus(e.clientX, e.clientY);
    }
  },
  { passive: true }
);

window.addEventListener('mouseleave', () => {
  state.pointer.inside = false;
});

window.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  if (pointOnUi(e.clientX, e.clientY)) return;

  const names = state.avatar ? state.avatar.hitTest(e.clientX, e.clientY) : [];
  if (!names.length) return;

  state.drag = { names, moved: false, startX: e.clientX, startY: e.clientY };
  window.pet.dragStart(e.screenX, e.screenY);
  e.preventDefault();
});

window.addEventListener('mouseup', async (e) => {
  if (!state.drag) return;
  const d = state.drag;
  state.drag = null;
  const res = await window.pet.dragEnd();

  const dx = Math.abs(e.clientX - d.startX);
  const dy = Math.abs(e.clientY - d.startY);
  const moved = (res && res.moved) || dx > 4 || dy > 4;
  if (moved) return;

  // 没拖动 → 当作一次点击互动
  const onHead = d.names.includes('Head');
  const action = onHead ? 'poke' : 'pet';
  window.pet.action(action).then((r) => {
    if (r && r.emotion) applyEmotion(r.emotion);
  });
  if (onHead) showComposer(true);
  else if (!state.composing) showComposer(false);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet.contextMenu();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideComposer();
  if (e.key === 'Enter' && !state.composing) {
    showComposer(true);
  }
});

window.addEventListener('resize', () => {
  log('debug', `窗口 resize：inner ${window.innerWidth}x${window.innerHeight}，dpr ${window.devicePixelRatio}`);
  if (state.avatar) state.avatar.resize();
});

// ------------------------------------------------------------------ 排障快照

/**
 * 给本机调试接口（/api/debug/pet-state）用的只读快照。
 * 只返回尺寸与缩放相关的数字，不含任何对话内容、不含用户数据。
 */
window.__petDebug = () => {
  const av = state.avatar;
  const stage = el.stage;
  return {
    ready: state.ready,
    dragging: Boolean(state.drag),
    composing: state.composing,
    dpr: window.devicePixelRatio || 1,
    events: state.__counts || null,
    view: {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      stageW: stage ? stage.clientWidth : null,
      stageH: stage ? stage.clientHeight : null,
    },
    avatar: av
      ? {
          screen: { w: av.app.screen.width, h: av.app.screen.height },
          resolution: av.app.renderer.resolution,
          canvasCss: {
            w: av.app.view.style.width,
            h: av.app.view.style.height,
          },
          canvasAttr: { w: av.app.view.width, h: av.app.view.height },
          scale: av.model.scale.x,
          pos: { x: av.model.x, y: av.model.y },
          lastLayout: av.lastLayout || null,
        }
      : null,
  };
};

/** 排障用：问某个画布坐标点不点得到它 */
window.__petHit = (x, y) => {
  if (!state.avatar) return null;
  return {
    ui: pointOnUi(x, y),
    names: state.avatar.hitTest(x, y),
  };
};

// ------------------------------------------------------------------ 主进程事件

function wireEvents() {
  window.pet.on('pet:say', async (p) => {
    if (!p) return;
    showBubble(p.text, { tag: p.tag || '' });
    if (p.speak) speak(p.text);
  });

  window.pet.on('chat:delta', (p) => {
    if (!p) return;
    showBubble(p.full || p.piece, { tag: '正在说', timeout: 0 });
  });

  window.pet.on('chat:reply', (r) => {
    if (!r) return;
    showBubble(r.reply, {
      tag: r.usedModel ? r.model || '' : '本地模式',
    });
    if (r.error) showHint('模型报错：' + r.error, { warn: true });
  });

  window.pet.on('emotion', (snap) => applyEmotion(snap));

  window.pet.on('config:changed', (cfg) => {
    state.config = cfg;
    el.bubbleName.textContent = cfg.pet?.name || '小满';
    if (state.avatar) {
      state.avatar.setFit({
        fit: cfg.pet?.fit,
        zoom: cfg.pet?.zoom,
        offsetX: cfg.pet?.offsetX,
        offsetY: cfg.pet?.offsetY,
        topInset: cfg.pet?.bubbleAreaHeight,
      });
    }
    syncVoiceEnabled(cfg);
  });

  window.pet.on('config:applied', (cfg) => {
    state.config = cfg;
    syncVoiceEnabled(cfg);
  });

  window.pet.on('pet:focusInput', () => showComposer(true));

  window.pet.on('pet:playMotion', (p) => {
    if (state.avatar) state.avatar.playMotion(p?.group || 'TapBody');
  });

  window.pet.on('pet:wake', () => {
    showBubble('嗯？我在。', { tag: '已唤醒' });
  });

  window.pet.on('voice:state', (p) => {
    if (!p) return;
    if (p.state === 'busy') setStatus(p.detail || '处理中', 'busy');
    else if (p.state === 'idle') setStatus(p.detail || '在听', 'listen');
    else if (p.state === 'active') setStatus('在听你说', 'listen');
    else setStatus('');
  });

  window.pet.on('voice:transcript', (p) => {
    if (p && p.text) showBubble(p.text, { tag: '我听到', timeout: 4000 });
  });

  window.pet.on('voice:audio', async (p) => {
    if (!p || !p.data) return;
    state.player = state.player || new VoicePlayer();
    state.speaking = true;
    state.avatar && state.avatar.setSpeaking(true);
    const buf = p.data instanceof ArrayBuffer ? p.data : new Uint8Array(p.data).buffer;
    await state.player.play(buf);
  });

  window.pet.on('voice:stop', () => {
    state.player && state.player.stop();
    state.speaking = false;
    state.avatar && state.avatar.setSpeaking(false);
  });

  window.pet.on('voice:error', (p) => {
    if (!p) return;
    showHint(p.message || '语音出错了', { warn: true });
    setStatus('');
  });

  window.pet.on('assets:changed', () => refreshVoiceAvailability());
}

function syncVoiceEnabled(cfg) {
  const want = Boolean(cfg?.voice?.wake?.enabled);
  const has = Boolean(state.mic);
  if (want && !has) enableMic(true);
  else if (!want && has) enableMic(false);
}

async function refreshVoiceAvailability() {
  const st = await window.pet.bootstrap();
  state.config = st.config;
  if (st.assets && !st.assets.whisper.binaryReady && st.config.voice.wake.enabled) {
    showHint('本地语音组件还没安装，请到管理页「语音」里下载。', { warn: true, ms: 8000 });
    window.pet.voiceSetEnabled(false);
  }
}

// ------------------------------------------------------------------ 启动

async function boot() {
  wireEvents();
  startFrameLoop();

  let boot;
  try {
    boot = await window.pet.bootstrap();
  } catch (err) {
    log('error', '初始化失败 ' + err.message);
    showHint('初始化失败：' + err.message, { warn: true, ms: 0 });
    return;
  }

  state.config = boot.config;
  el.bubbleName.textContent = boot.config.pet?.name || '小满';

  // 摄像头情绪：只在配置里明确打开时才启动
  if (boot.config.emotion?.videoEnabled) {
    try {
      state.camera = new FaceEmotion();
      await state.camera.start({ intervalMs: boot.config.emotion.videoSampleMs || 4000 });
      log('info', '摄像头情绪已启动');
    } catch (err) {
      log('error', '摄像头情绪启动失败 ' + err.message);
      state.camera = null;
      showHint('摄像头情绪打不开：' + err.message, { warn: true });
    }
  }

  // 模型
  const modelId = boot.config.pet?.model || 'Haru';
  const modelUrl = `app://local/assets/live2d/${modelId}/${modelId}.model3.json`;
  try {
    state.avatar = new PetAvatar();
    await state.avatar.create({ container: el.stage, modelUrl });
    state.avatar.setFit({
      fit: boot.config.pet?.fit || 'height',
      zoom: boot.config.pet?.zoom || 1,
      offsetX: boot.config.pet?.offsetX || 0,
      offsetY: boot.config.pet?.offsetY || 0,
      topInset: boot.config.pet?.bubbleAreaHeight || 0,
    });
    applyEmotion(boot.emotion);
    state.ready = true;
    const im = state.avatar.model.internalModel;
    const c = state.avatar.content || {};
    log(
      'info',
      `模型已加载 ${modelId}，画布 ${Math.round(im.width)}x${Math.round(im.height)}，` +
        `窗口 ${state.avatar.app.screen.width}x${state.avatar.app.screen.height}，` +
        `内容范围 ${c.raw ? `${c.raw.x0.toFixed(3)},${c.raw.y0.toFixed(3)}~${c.raw.x1.toFixed(3)},${c.raw.y1.toFixed(3)}` : `未测得(${c.error || '原因未知'})`}` +
        `（安全盒 ±${(c.hx || 0).toFixed(3)},±${(c.hy || 0).toFixed(3)}），` +
        `缩放 ${state.avatar.model.scale.x.toFixed(4)}，参数 ${state.avatar.paramCount} 个，dpr ${window.devicePixelRatio}`
    );
  } catch (err) {
    log('error', 'Live2D 加载失败 ' + (err && err.message));
    showHint('Live2D 模型加载失败：' + (err && err.message), { warn: true, ms: 0 });
    return;
  }

  await enableMic(Boolean(boot.config.voice?.wake?.enabled));
  await refreshVoiceAvailability();

  if (!boot.modelReady) {
    showHint('还没配置对话模型，我先用内置规则陪你。到管理页填上 Key 就能聊天了。', { ms: 9000 });
  }

  // 开场
  const hour = new Date().getHours();
  const greet =
    hour >= 23 || hour < 5
      ? '这么晚还没睡？'
      : hour < 9
        ? '早呀。'
        : hour < 12
          ? '上午好。'
          : hour < 18
            ? '下午好。'
            : '晚上好。';
  setTimeout(() => showBubble(greet, { tag: '刚醒过来', timeout: 6000 }), 700);
}

boot();
