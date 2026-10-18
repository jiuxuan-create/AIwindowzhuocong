'use strict';
/**
 * 桌宠渲染进程的唯一对外接口。
 * 只暴露白名单通道，渲染端拿不到 Node 能力。
 */
const { contextBridge, ipcRenderer } = require('electron');

const INBOUND = new Set([
  'chat:delta',
  'chat:reply',
  'pet:say',
  'pet:wake',
  'pet:focusInput',
  'pet:playMotion',
  'voice:state',
  'voice:transcript',
  'voice:wake',
  'voice:audio',
  'voice:error',
  'voice:enabled',
  'voice:stop',
  'emotion',
  'config:changed',
  'config:applied',
  'assets:changed',
]);

contextBridge.exposeInMainWorld('pet', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  state: () => ipcRenderer.invoke('app:state'),

  send: (text, signals) => ipcRenderer.invoke('chat:send', { text, signals }),

  setInteractive: (interactive) => ipcRenderer.invoke('pet:interactive', { interactive }),
  dragStart: (screenX, screenY) => ipcRenderer.invoke('pet:dragStart', { screenX, screenY }),
  dragMove: (screenX, screenY) => ipcRenderer.invoke('pet:dragMove', { screenX, screenY }),
  dragEnd: () => ipcRenderer.invoke('pet:dragEnd'),

  action: (action, payload) => ipcRenderer.invoke('pet:action', { action, payload }),
  contextMenu: () => ipcRenderer.invoke('pet:contextMenu'),
  openConsole: () => ipcRenderer.invoke('pet:openConsole'),

  voiceUtterance: (samples, features) => ipcRenderer.invoke('voice:utterance', { samples, features }),
  voiceSetEnabled: (enabled) => ipcRenderer.invoke('voice:setEnabled', { enabled }),
  tts: (text) => ipcRenderer.invoke('voice:tts', { text }),
  stopSpeaking: () => ipcRenderer.invoke('voice:stopSpeaking'),

  log: (level, message) => ipcRenderer.invoke('app:log', { level, message: String(message) }),

  on: (channel, cb) => {
    if (!INBOUND.has(channel)) {
      console.warn('[preload] 未允许的通道', channel);
      return () => {};
    }
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch (err) {
        console.error('[preload] 回调异常', channel, err);
      }
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
