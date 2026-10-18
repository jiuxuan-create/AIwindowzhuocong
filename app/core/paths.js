'use strict';
/**
 * 路径解析。
 * - 开发模式：数据与模型放在项目根目录 runtime/ 下，方便调试与查看。
 * - 打包模式：数据放在 Electron userData，模型放在 userData/models。
 */
const path = require('node:path');
const fs = require('node:fs');

let electron = null;
try {
  electron = require('electron');
} catch {
  electron = null;
}

const APP_DIR = path.resolve(__dirname, '..'); // <root>/app
const PROJECT_ROOT = path.resolve(APP_DIR, '..'); // <root>

const isPackaged = !!(electron && electron.app && electron.app.isPackaged);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 可写数据目录：config / memory / logs */
function dataDir() {
  const dir = isPackaged
    ? path.join(electron.app.getPath('userData'), 'data')
    : path.join(PROJECT_ROOT, 'runtime', 'data');
  return ensureDir(dir);
}

/** 重型模型目录：whisper 二进制与权重、mediapipe 资源 */
function modelDir() {
  const override = process.env.PET_MODEL_DIR;
  const dir = override
    ? path.resolve(override)
    : isPackaged
      ? path.join(electron.app.getPath('userData'), 'models')
      : path.join(PROJECT_ROOT, 'runtime', 'models');
  return ensureDir(dir);
}

/** 随包分发的只读资源目录（renderer / assets） */
function appDir() {
  return APP_DIR;
}

function assetPath(...parts) {
  return path.join(APP_DIR, 'assets', ...parts);
}

function configPath() {
  return path.join(dataDir(), 'config.json');
}

function memoryDir() {
  return ensureDir(path.join(dataDir(), 'memory'));
}

function logDir() {
  return ensureDir(path.join(dataDir(), 'logs'));
}

function tempDir() {
  return ensureDir(path.join(dataDir(), 'tmp'));
}

/** Live2D 模型根目录；用户也可以把自有模型放到这里 */
function live2dDir() {
  return path.join(APP_DIR, 'assets', 'live2d');
}

function live2dModels() {
  const root = live2dDir();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(root, d.name);
      const model3 = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.model3.json'))
        .map((f) => path.join(dir, f));
      return model3.length ? { id: d.name, dir, model3: model3[0] } : null;
    })
    .filter(Boolean);
}

module.exports = {
  APP_DIR,
  PROJECT_ROOT,
  isPackaged,
  ensureDir,
  dataDir,
  modelDir,
  appDir,
  assetPath,
  configPath,
  memoryDir,
  logDir,
  tempDir,
  live2dDir,
  live2dModels,
};
