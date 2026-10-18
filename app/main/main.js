'use strict';
/**
 * 应用入口：装配服务 → 建窗口 → 起托盘 → 起管理页。
 *
 * 这是一个常驻托盘应用，关掉窗口不等于退出。
 */
const path = require('node:path');
const { app, BrowserWindow, shell, dialog, nativeTheme } = require('electron');

const { config } = require('../core/config');
const { dataDir, modelDir, live2dModels } = require('../core/paths');
const { scoped } = require('../core/logger');
const { MemoryStore } = require('../core/memory/store');
const { Retriever } = require('../core/memory/retriever');
const { MemoryExtractor } = require('../core/memory/extractor');
const { Summarizer } = require('../core/memory/summarizer');
const { LLMClient } = require('../core/llm');
const { EmotionState } = require('../core/emotion/state');
const { ChatEngine } = require('../core/chat');
const { VoiceService } = require('../core/voice/service');
const { RuntimeAssets } = require('../core/runtime-assets');

const protocol = require('./protocol');
const { PetWindow } = require('./windows/petWindow');
const { PetTray } = require('./tray');
const { ConsoleServer } = require('./server');
const ipc = require('./ipc');

const log = scoped('main');
const VERSION = require('../../package.json').version;

const isDev = process.argv.includes('--dev');

// 单实例：重复启动时把已有实例唤到前面
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  protocol.registerScheme();
  app.on('second-instance', () => ctx.actions && ctx.actions.bringToFront());
  bootstrap();
}

// ---------------------------------------------------------------- 服务装配

function createServices() {
  const store = new MemoryStore(() => config.all());
  const retriever = new Retriever(() => config.all());
  retriever.build(store.longterm);

  const llm = new LLMClient(() => config.all());
  const emotion = new EmotionState(() => config.all());
  const extractor = new MemoryExtractor({ llm, store, getConfig: () => config.all() });
  const summarizer = new Summarizer({ llm, store, getConfig: () => config.all() });
  const chat = new ChatEngine({ config, llm, store, retriever, extractor, summarizer, emotion });
  chat.summarizer = summarizer;
  const voice = new VoiceService({ config, chat });
  const assets = new RuntimeAssets();

  return { store, retriever, llm, emotion, extractor, summarizer, chat, voice, assets };
}

const ctx = {
  version: VERSION,
  config,
  services: null,
  petWindow: null,
  tray: null,
  server: null,
  actions: {},
  send(channel, payload) {
    if (ctx.petWindow) ctx.petWindow.send(channel, payload);
    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== (ctx.petWindow && ctx.petWindow.win) && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  },
};

function bootstrap() {
  app.on('window-all-closed', (e) => e.preventDefault());

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    protocol.install();

    const svc = createServices();
    ctx.services = svc;
    Object.assign(ctx, svc);

    // 让 server / tray / ipc 都能拿到同一份上下文
    ctx.petWindow = new PetWindow(config);
    ctx.petWindow.create();

    ctx.actions = buildActions();
    ctx.assets = svc.assets;
    ctx.voice = svc.voice;
    ctx.chat = svc.chat;
    ctx.emotion = svc.emotion;
    ctx.store = svc.store;
    ctx.retriever = svc.retriever;
    ctx.llm = svc.llm;

    ctx.server = new ConsoleServer(ctx);
    try {
      await ctx.server.start();
    } catch (err) {
      log.error('管理页启动失败', err.message);
      dialog.showErrorBox('管理页启动失败', `本地端口无法监听：${err.message}`);
    }

    ctx.tray = new PetTray(ctx);
    ctx.tray.create();

    ipc.setup(ctx);
    wireServices();

    startIdleChatter();

    if (config.get('console.openOnStart', false)) ctx.actions.openConsole();

    log.info(`启动完成：数据 ${dataDir()}，模型 ${modelDir()}，Live2D ${live2dModels().length} 个模型`);
    if (isDev) ctx.petWindow.webContents.openDevTools({ mode: 'detach' });

    app.on('activate', () => ctx.actions.togglePet(true));
  });

  app.on('before-quit', () => {
    try {
      ctx.services && ctx.services.store.dispose();
      ctx.services && ctx.services.emotion.save(true);
      ctx.services && ctx.services.store.compactAll();
    } catch (err) {
      log.warn('退出清理失败', err.message);
    }
  });
}

// ---------------------------------------------------------------- 事件接线

function wireServices() {
  ctx.voice.on('state', (s) => ctx.send('voice:state', s));
  ctx.voice.on('transcript', (t) => ctx.send('voice:transcript', t));
  ctx.voice.on('wake', (w) => {
    ctx.send('voice:wake', w);
    ctx.petWindow.send('pet:wake', w);
  });
  ctx.voice.on('audio', (a) => ctx.send('voice:audio', { data: a.data, mime: a.mime }));
  ctx.voice.on('reply', (r) => {
    ctx.send('chat:reply', r);
    ctx.send('pet:say', { text: r.reply, speak: false, reset: true });
  });
  ctx.voice.on('greeted', () => {
    const line = `嗯，我在。`;
    ctx.send('pet:say', { text: line, speak: true });
  });
  ctx.voice.on('error', (e) => ctx.send('voice:error', e));

  // 情绪变化低频推给渲染端，用于待机表现
  setInterval(() => {
    if (!ctx.emotion) return;
    ctx.emotion.tick();
    ctx.send('emotion', ctx.emotion.snapshot());
  }, 20000).unref?.();
}

function startIdleChatter() {
  const timer = setInterval(async () => {
    try {
      if (!ctx.chat || !ctx.petWindow || !ctx.petWindow.win) return;
      if (ctx.petWindow.win.isDestroyed() || !ctx.petWindow.win.isVisible()) return;
      if (config.get('pet.silentMode', false)) return;
      const snap = ctx.emotion.snapshot();
      const gapMin = (Date.now() - (snap.lastInteractionTs || 0)) / 60000;
      if (gapMin < 25) return;
      if (Math.random() > 0.28) return;
      const line = ctx.chat.proactiveLine();
      if (!line) return;
      ctx.send('pet:say', { text: line, speak: config.get('voice.autoSpeak', true) });
      if (config.get('voice.autoSpeak', true)) ctx.voice.speak(line);
      ctx.emotion.nudge(0.01, 0.02, 'proactive');
    } catch (err) {
      log.warn('主动搭话失败', err.message);
    }
  }, 4 * 60 * 1000);
  timer.unref?.();
}

// ---------------------------------------------------------------- actions

function buildActions() {
  return {
    togglePet(forceShow) {
      const w = ctx.petWindow;
      if (forceShow === true) w.show();
      else if (forceShow === false) w.hide();
      else w.toggle();
      if (ctx.tray) ctx.tray.build();
    },

    bringToFront() {
      const w = ctx.petWindow;
      if (!w || !w.win || w.win.isDestroyed()) return w && w.create();
      w.win.showInactive();
      w.win.setAlwaysOnTop(true, 'screen-saver');
      w.win.moveTop();
    },

    openConsole() {
      const url = ctx.server ? ctx.server.url : null;
      if (!url) return;
      shell.openExternal(url);
    },

    focusInput() {
      ctx.petWindow.show();
      ctx.petWindow.send('pet:focusInput', {});
    },

    resetPosition() {
      ctx.petWindow.resetPosition();
    },

    reloadPet() {
      ctx.petWindow.reload();
    },

    quit() {
      app.isQuitting = true;
      app.quit();
    },

    /** 桌宠直接说一句（不经过模型） */
    say(text, { speak = true, source = 'local' } = {}) {
      const clean = String(text || '').slice(0, 400);
      if (!clean) return;
      ctx.send('pet:say', { text: clean, speak: false });
      ctx.store.addMessage({ role: 'pet', text: clean, source });
      if (speak && !config.get('pet.silentMode', false) && config.get('voice.autoSpeak', true)) {
        ctx.voice.speak(clean);
      }
    },

    pushTurn(result) {
      ctx.send('chat:reply', result);
      ctx.send('pet:say', { text: result.reply, speak: false });
    },

    petAction(action, payload) {
      switch (action) {
        case 'pet': // 摸头
          ctx.emotion.react({ kind: 'pet' });
          ctx.emotion.nudge(0.04, 0.04, 'pet');
          ctx.send('pet:playMotion', { group: 'tapBody' });
          return { ok: true, emotion: ctx.emotion.snapshot() };
        case 'poke':
          ctx.emotion.nudge(-0.02, 0.12, 'poke');
          ctx.send('pet:playMotion', { group: 'tapHead' });
          return { ok: true, emotion: ctx.emotion.snapshot() };
        case 'feed':
          ctx.emotion.react({ kind: 'feed' });
          return { ok: true, emotion: ctx.emotion.snapshot() };
        case 'emotion':
          if (payload && typeof payload.valence === 'number') {
            ctx.emotion.nudge(payload.valence, payload.arousal || 0, 'renderer');
          }
          return { ok: true };
        default:
          return { ok: false, error: `未知动作 ${action}` };
      }
    },

    emotionNudge(dv, da, reason) {
      ctx.emotion.nudge(dv, da, reason);
      ctx.send('emotion', ctx.emotion.snapshot());
    },

    broadcastConfig() {
      ctx.send('config:changed', config.publicConfig());
      if (ctx.tray) ctx.tray.build();
    },

    async onConfigChanged(next) {
      ctx.send('config:changed', config.publicConfig());
      if (ctx.tray) ctx.tray.build();
      if (ctx.petWindow) {
        ctx.petWindow.refreshClickThrough();
        if (next.pet) {
          if (typeof next.pet.scale === 'number') ctx.petWindow.setScale(next.pet.scale);
          if (typeof next.pet.opacity === 'number') ctx.petWindow.setOpacity(next.pet.opacity);
          if (typeof next.pet.alwaysOnTop === 'boolean') ctx.petWindow.setAlwaysOnTop(next.pet.alwaysOnTop);
        }
      }
      // 窗口尺寸/位置跟着缩放走，渲染端也要重排
      ctx.send('config:applied', config.publicConfig());
    },

    onAssetsChanged() {
      ctx.send('assets:changed', ctx.assets.status());
      if (ctx.tray) ctx.tray.build();
    },

    onVoiceToggle(enabled) {
      if (enabled) {
        const st = ctx.assets.status().whisper;
        if (!st.binaryReady) {
          ctx.send('voice:error', {
            stage: 'setup',
            message: '还没有安装本地语音识别组件，请到管理页的「语音」里一键下载。',
          });
        }
      } else {
        ctx.voice.setState('off', '已关闭');
      }
      ctx.send('voice:enabled', { enabled });
    },
  };
}
