// 把运行时需要的第三方前端产物复制进 app/renderer/pet/vendor。
// 这样打包后的应用不依赖 node_modules，也不需要在运行时联网取 CDN。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'app', 'renderer', 'pet', 'vendor');

fs.mkdirSync(VENDOR, { recursive: true });

function copy(from, to) {
  if (!fs.existsSync(from)) {
    console.warn(`[vendor] 缺少 ${path.relative(ROOT, from)}，跳过`);
    return false;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const kb = (fs.statSync(to).size / 1024).toFixed(0);
  console.log(`[vendor] ${path.relative(ROOT, to)}  ${kb} KB`);
  return true;
}

const steps = [];
const problems = [];

// 1) Live2D Cubism Core（由 scripts/fetch-live2d.mjs 下载）
const core = path.join(VENDOR, 'live2dcubismcore.min.js');
if (!fs.existsSync(core)) problems.push('live2dcubismcore.min.js 缺失，请先运行 npm run fetch:live2d');

// 2) pixi.js UMD
if (!copy(path.join(NM, 'pixi.js', 'dist', 'browser', 'pixi.min.js'), path.join(VENDOR, 'pixi.min.js'))) {
  problems.push('pixi.js 未安装');
}

// 3) pixi-live2d-display（cubism4 版本）
if (
  !copy(
    path.join(NM, 'pixi-live2d-display', 'dist', 'cubism4.min.js'),
    path.join(VENDOR, 'pixi-live2d-display.min.js')
  )
) {
  problems.push('pixi-live2d-display 未安装');
}

// 4) MediaPipe Tasks Vision（面部情绪，可选）
const mpSrc = path.join(NM, '@mediapipe', 'tasks-vision');
const mpDest = path.join(VENDOR, 'mediapipe');
if (fs.existsSync(mpSrc)) {
  copy(path.join(mpSrc, 'vision_bundle.mjs'), path.join(mpDest, 'vision_bundle.mjs'));
  for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
    copy(path.join(mpSrc, 'wasm', f), path.join(mpDest, 'wasm', f));
  }
} else {
  console.warn('[vendor] @mediapipe/tasks-vision 未安装，摄像头情绪识别将不可用（不影响其它功能）');
}

const total = (function size(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += size(p);
    else n += fs.statSync(p).size;
  }
  return n;
})(VENDOR);

console.log(`[vendor] 完成，共 ${(total / 1024 / 1024).toFixed(1)} MB`);
if (problems.length) {
  console.warn('[vendor] 需要注意：');
  for (const p of problems) console.warn('  - ' + p);
}
steps.push('ok');
