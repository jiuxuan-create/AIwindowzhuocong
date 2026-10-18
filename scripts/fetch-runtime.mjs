// 预置运行时资源（可选，用于离线开箱）：
//   - whisper.cpp Windows 二进制 + ggml 语音模型
//   - MediaPipe face_landmarker.task（面部情绪）
// 应用内也有同样的下载入口（管理页 → 语音 / 情绪），这里只是提前拉好。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODEL_DIR = process.env.PET_MODEL_DIR || path.join(ROOT, 'runtime', 'models');

const UA = { 'User-Agent': 'xiaoman-pet-setup' };
const RELEASE = 'b5454';
// 镜像在前：Github 直连在国内常常只有几 KB/s
const BIN_URLS = [
  `https://ghfast.top/https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-bin-x64.zip`,
  `https://ghproxy.net/https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-bin-x64.zip`,
  `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-bin-x64.zip`,
];
const MODEL_HOSTS = [
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
];
const FACE_URLS = [
  'https://cdn.jsdelivr.net/gh/google-ai-edge/mediapipe-samples@main/examples/face_landmarker/js/face_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
];

const WHISPER_SIZE = process.env.PET_WHISPER_MODEL || 'base';
const SIZE_MB = { tiny: 75, base: 142, small: 466, medium: 1500 }[WHISPER_SIZE];

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

async function download(url, dest, label) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0;
  let lastLog = 0;
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    out.write(Buffer.from(value));
    const now = Date.now();
    if (now - lastLog > 3000) {
      lastLog = now;
      process.stdout.write(
        `\r  ${label}  ${mb(got)}${total ? ' / ' + mb(total) + `  ${((got / total) * 100).toFixed(0)}%` : ''}   `
      );
    }
  }
  await new Promise((r) => out.end(r));
  process.stdout.write('\r' + ' '.repeat(70) + '\r');
  if (total && got < total) throw new Error(`不完整 ${got}/${total}`);
  return got;
}

function exists(p, minBytes = 1024) {
  try {
    return fs.statSync(p).size >= minBytes;
  } catch {
    return false;
  }
}

async function firstOk(urls, dest, label) {
  let lastErr;
  for (const u of urls) {
    try {
      return await download(u, dest, label);
    } catch (e) {
      lastErr = e;
      console.warn(`  ${label} 源失败：${e.message}`);
      await fsp.rm(dest, { force: true });
    }
  }
  throw lastErr;
}

async function main() {
  const whisperHome = path.join(MODEL_DIR, 'whisper');
  const binPath = path.join(whisperHome, 'Release', 'whisper-cli.exe');
  const modelPath = path.join(whisperHome, 'models', `ggml-${WHISPER_SIZE}.bin`);
  const facePath = path.join(MODEL_DIR, 'mediapipe', 'face_landmarker.task');

  console.log(`[runtime] 目标目录 ${MODEL_DIR}`);
  console.log(`[runtime] 语音模型规格 ${WHISPER_SIZE}（约 ${SIZE_MB} MB）`);

  if (exists(binPath, 100 * 1024)) {
    console.log('[runtime] whisper 二进制已存在，跳过');
  } else {
    console.log('[runtime] 下载 whisper.cpp 二进制…');
    const zip = path.join(MODEL_DIR, 'whisper-bin-x64.zip');
    await firstOk(BIN_URLS, zip, 'whisper.cpp');
    await fsp.mkdir(whisperHome, { recursive: true });
    const r = spawnSync('tar', ['-xf', zip, '-C', whisperHome], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('解压 whisper.cpp 失败');
    await fsp.rm(zip, { force: true });
    if (!fs.existsSync(binPath)) {
      const found = findFile(whisperHome, 'whisper-cli.exe');
      if (found) console.log(`[runtime] 实际路径 ${found}`);
      else throw new Error('解压后未找到 whisper-cli.exe');
    }
  }

  if (exists(modelPath, 10 * 1024 * 1024)) {
    console.log('[runtime] 语音模型已存在，跳过');
  } else {
    console.log('[runtime] 下载语音模型…');
    await firstOk(MODEL_HOSTS.map((h) => `${h}/ggml-${WHISPER_SIZE}.bin`), modelPath, 'ggml 模型');
  }

  if (exists(facePath, 1024 * 1024)) {
    console.log('[runtime] 面部模型已存在，跳过');
  } else {
    console.log('[runtime] 下载面部情绪模型…');
    await firstOk(FACE_URLS, facePath, 'face_landmarker');
  }

  console.log('[runtime] 全部就绪');
}

function findFile(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return null;
}

main().catch((e) => {
  console.error('[runtime] 失败：', e.message);
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_/i.test(String(e.message))) {
    console.error(
      '[runtime] 看起来是证书链问题：这台机器上 Node 自带的根证书不认这些下载源。\n' +
        '          解决办法：用 `npm run fetch:runtime`（脚本里已经带了 --use-system-ca），\n' +
        '          或者手动执行 `node --use-system-ca scripts/fetch-runtime.mjs`。'
    );
  }
  process.exitCode = 1;
});
