'use strict';
/**
 * 托盘菜单。Windows 上桌宠本体是透明窗口，托盘是主要的功能入口。
 */
const path = require('node:path');
const { Tray, Menu, nativeImage, app, shell, dialog } = require('electron');
const { scoped } = require('../core/logger');

const log = scoped('tray');

const SCALES = [
  { label: '70%', value: 0.7 },
  { label: '85%', value: 0.85 },
  { label: '100%', value: 1 },
  { label: '120%', value: 1.2 },
  { label: '150%', value: 1.5 },
  { label: '180%', value: 1.8 },
];

class PetTray {
  constructor(ctx) {
    this.ctx = ctx;
    this.tray = null;
  }

  iconPath() {
    return path.join(__dirname, '..', 'assets', 'icons', 'tray.png');
  }

  create() {
    let img = nativeImage.createFromPath(this.iconPath());
    if (img.isEmpty()) {
      log.warn('托盘图标缺失，使用空图标兜底');
    } else {
      img = img.resize({ width: 16, height: 16 });
    }
    this.tray = new Tray(img);
    this.tray.setToolTip(`${this.ctx.config.get('pet.name', '桌宠')} · 右键查看菜单`);
    this.tray.on('click', () => this.ctx.actions.togglePet());
    this.tray.on('double-click', () => this.ctx.actions.openConsole());
    this.build();
    return this.tray;
  }

  build() {
    if (!this.tray) return;
    const c = this.ctx.config;
    const pet = this.ctx.petWindow;
    const visible = pet.win && !pet.win.isDestroyed() && pet.win.isVisible();

    const menu = Menu.buildFromTemplate([
      {
        label: visible ? '隐藏桌宠' : '显示桌宠',
        click: () => this.ctx.actions.togglePet(),
      },
      { type: 'separator' },
      {
        label: '说点什么…',
        click: () => this.ctx.actions.focusInput(),
      },
      {
        label: '静音（不说话）',
        type: 'checkbox',
        checked: c.get('pet.silentMode', false),
        click: (item) => {
          c.set('pet.silentMode', item.checked);
          this.ctx.actions.broadcastConfig();
        },
      },
      {
        label: '语音对话（叫名字唤醒）',
        type: 'checkbox',
        checked: c.get('voice.wake.enabled', false),
        enabled: this.ctx.assets.status().whisper.binaryReady,
        click: (item) => {
          c.set('voice.wake.enabled', item.checked);
          this.ctx.actions.onVoiceToggle(item.checked);
          this.ctx.actions.broadcastConfig();
        },
      },
      { type: 'separator' },
      {
        label: '大小',
        submenu: [
          ...SCALES.map((s) => ({
            label: s.label,
            type: 'radio',
            checked: Math.abs((c.get('pet.scale') || 1) - s.value) < 0.01,
            click: () => {
              pet.setScale(s.value);
              this.ctx.actions.broadcastConfig();
            },
          })),
          { type: 'separator' },
          { label: '回到默认位置', click: () => this.ctx.actions.resetPosition() },
        ],
      },
      {
        label: '鼠标穿透（点不到它）',
        type: 'checkbox',
        checked: c.get('pet.clickThrough', false),
        click: (item) => {
          c.set('pet.clickThrough', item.checked);
          pet.refreshClickThrough();
          this.ctx.actions.broadcastConfig();
        },
      },
      {
        label: '始终置顶',
        type: 'checkbox',
        checked: c.get('pet.alwaysOnTop', true),
        click: (item) => {
          pet.setAlwaysOnTop(item.checked);
          this.ctx.actions.broadcastConfig();
        },
      },
      { type: 'separator' },
      { label: '打开管理页', click: () => this.ctx.actions.openConsole() },
      { label: '重载桌宠画面', click: () => this.ctx.actions.reloadPet() },
      {
        label: '打开数据文件夹',
        click: () => shell.openPath(require('../core/paths').dataDir()),
      },
      {
        label: '关于',
        click: () => {
          dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: `${this.ctx.config.get('pet.name', '桌宠')}`,
            detail:
              `版本 ${this.ctx.version}\n` +
              `管理页：${this.ctx.server ? this.ctx.server.url : '未启动'}\n` +
              `数据目录：${require('../core/paths').dataDir()}\n\n` +
              `Live2D 模型：${this.ctx.config.get('pet.model')}（Live2D Inc. 免费示例素材）\n` +
              `本应用为个人本地项目，不联网上传你的对话与记忆。`,
            buttons: ['好'],
            noLink: true,
          });
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => this.ctx.actions.quit() },
    ]);

    this.tray.setContextMenu(menu);
    this.menu = menu;
  }
}

module.exports = { PetTray };
