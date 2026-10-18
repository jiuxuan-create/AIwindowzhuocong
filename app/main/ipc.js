'use strict';
/**
 * 渲染进程 ↔ 主进程 的通道。
 * 约定：渲染端只通过下列 invoke 通道请求动作，主进程只通过 send 通道推送状态，
 * 渲染端不直接触碰文件系统或网络。
 */
const { ipcMain, shell, Menu, screen } = require('electron');
const { scoped } = require('../core/logger');

const log = scoped('ipc');

function setup(ctx) {
  let drag = null;

  const safe = (name, fn) => {
    ipcMain.handle(name, async (event, payload) => {
      try {
        return await fn(payload, event);
      } catch (err) {
        log.error(`通道 ${name} 失败`, err.message);
        return { error: err.message };
      }
    });
  };

  // ---- 初始化 ----
  safe('app:bootstrap', () => {
    ctx.emotion.tick();
    return {
      config: ctx.config.publicConfig(),
      emotion: ctx.emotion.snapshot(),
      voiceState: ctx.voice.state,
      version: ctx.version,
      consoleUrl: ctx.server ? ctx.server.url : null,
      assets: ctx.assets.status(),
      modelReady: ctx.llm.isConfigured(),
    };
  });

  safe('app:state', () => {
    ctx.emotion.tick();
    return {
      emotion: ctx.emotion.snapshot(),
      voiceState: ctx.voice.state,
      modelReady: ctx.llm.isConfigured(),
      silent: ctx.config.get('pet.silentMode', false),
    };
  });

  // ---- 对话 ----
  safe('chat:send', async ({ text, signals }) => {
    const result = await ctx.chat.send({
      text,
      source: 'text',
      signals: signals || {},
      onDelta: (piece, full) => {
        ctx.send('chat:delta', { piece, full });
      },
    });
    ctx.send('chat:reply', result);
    if (ctx.config.get('voice.autoSpeak', true) && !ctx.config.get('pet.silentMode', false)) {
      ctx.voice.speak(result.reply);
    }
    return result;
  });

  // ---- 桌宠交互 ----
  safe('pet:interactive', ({ interactive }) => {
    ctx.petWindow.setInteractive(Boolean(interactive));
    return { ok: true };
  });

  safe('pet:dragStart', ({ screenX, screenY }) => {
    const win = ctx.petWindow.win;
    if (!win || win.isDestroyed()) return { ok: false };
    const [x, y] = win.getPosition();
    drag = { winX: x, winY: y, cursorX: screenX, cursorY: screenY, moved: false, lastX: x, lastY: y };
    return { ok: true };
  });

  safe('pet:dragMove', ({ screenX, screenY }) => {
    if (!drag) return { ok: false };
    const win = ctx.petWindow.win;
    if (!win || win.isDestroyed()) return { ok: false };
    const dx = screenX - drag.cursorX;
    const dy = screenY - drag.cursorY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) drag.moved = true;
    // 位置必须落在物理像素网格上（见 petWindow.gridStep），否则系统每取整一次
    // 就把零头加到窗口尺寸上，拖动过程中桌宠会一路变大
    const p = ctx.petWindow.snapPosition(
      Math.round(drag.winX + dx),
      Math.round(drag.winY + dy)
    );
    // 值没变就别动窗口：多余的 setPosition 会白触发一串系统窗口事件
    if (p.x === drag.lastX && p.y === drag.lastY) return { ok: true, moved: drag.moved };
    drag.lastX = p.x;
    drag.lastY = p.y;
    win.setPosition(p.x, p.y);
    return { ok: true, moved: drag.moved };
  });

  safe('pet:dragEnd', () => {
    const moved = drag && drag.moved;
    drag = null;
    if (moved) ctx.petWindow.savePosition();
    return { ok: true, moved };
  });

  safe('pet:action', ({ action, payload }) => ctx.actions.petAction(action, payload));

  safe('pet:contextMenu', () => {
    log.debug('弹出右键菜单');
    const template = [
      { label: '说点什么…', click: () => ctx.actions.focusInput() },
      {
        label: '开心一点',
        click: () => ctx.actions.emotionNudge(0.25, 0.1, 'context-menu'),
      },
      {
        label: '安静一会儿',
        click: () => ctx.actions.emotionNudge(-0.05, -0.15, 'context-menu'),
      },
      { type: 'separator' },
      {
        label: '大小',
        submenu: [0.7, 0.85, 1, 1.2, 1.5, 1.8].map((s) => ({
          label: `${Math.round(s * 100)}%`,
          click: () => {
            log.debug(`菜单选了大小 ${s}`);
            ctx.petWindow.setScale(s);
            ctx.actions.broadcastConfig();
          },
        })),
      },
      { label: '回到默认位置', click: () => ctx.actions.resetPosition() },
      { label: '打开管理页', click: () => ctx.actions.openConsole() },
      { type: 'separator' },
      { label: '隐藏桌宠', click: () => ctx.actions.togglePet(false) },
    ];
    Menu.buildFromTemplate(template).popup({ window: ctx.petWindow.win });
    return { ok: true };
  });

  safe('pet:openConsole', () => {
    ctx.actions.openConsole();
    return { ok: true, url: ctx.server ? ctx.server.url : null };
  });

  // ---- 语音 ----
  safe('voice:utterance', async ({ samples, features }) => {
    if (!ctx.config.get('voice.wake.enabled', false)) return { ok: false, reason: 'disabled' };
    ctx.voice.handleUtterance({ samples, features });
    return { ok: true };
  });

  safe('voice:setEnabled', ({ enabled }) => {
    ctx.config.set('voice.wake.enabled', Boolean(enabled));
    ctx.actions.onVoiceToggle(Boolean(enabled));
    ctx.actions.broadcastConfig();
    return { ok: true };
  });

  safe('voice:tts', async ({ text }) => {
    const r = await ctx.voice.speak(String(text || '').slice(0, 400));
    return { ok: Boolean(r) };
  });

  safe('voice:stopSpeaking', () => {
    ctx.send('voice:stop', {});
    return { ok: true };
  });

  // ---- 杂项 ----
  safe('app:openExternal', ({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  safe('app:log', ({ level, message }) => {
    const fn = log[level] || log.info;
    fn('[renderer]', String(message).slice(0, 500));
    return { ok: true };
  });

  safe('app:screens', () =>
    screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor }))
  );

  log.info('IPC 通道已注册');
}

module.exports = { setup };
