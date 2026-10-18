'use strict';
/**
 * 本地语音识别：whisper.cpp。
 *
 * 选它而不是 Node 原生绑定，是为了彻底避开 N-API / ABI 与 Electron 版本的耦合：
 * whisper-cli 是独立进程，只要二进制和权重在位就能跑，崩溃也不会带倒主进程。
 * 二进制与权重都放在 modelDir()/whisper 下，首次使用时可一键下载。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { modelDir, tempDir } = require('../paths');
const { download } = require('../net');
const { scoped } = require('../logger');

const log = scoped('voice.whisper');

const RELEASE_TAG = 'b5454';
const OFFICIAL_ZIP = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE_TAG}/whisper-bin-x64.zip`;
// 镜像放在前面：Github 直连在国内常常只有几 KB/s，能成功但慢到没法用。
const BIN_SOURCES = [
  { url: `https://ghfast.top/${OFFICIAL_ZIP}`, name: 'ghfast 镜像' },
  { url: `https://ghproxy.net/${OFFICIAL_ZIP}`, name: 'ghproxy 镜像' },
  { url: OFFICIAL_ZIP, name: 'Github 官方源' },
];

const MODEL_SOURCES = [
  { url: 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main', name: 'hf-mirror 镜像' },
  { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main', name: 'HuggingFace 官方源' },
];

// 多个源之间切换时，低于这个速度就换下一个源；最后一个源不再设门槛，
// 保证「慢但能用」的网络最后也一定能下完。
const MIN_BPS = 80 * 1024;

const MODELS = {
  tiny: { file: 'ggml-tiny.bin', mb: 75, note: '最快，中文准确率一般' },
  base: { file: 'ggml-base.bin', mb: 142, note: '速度与准确率的平衡点（推荐）' },
  small: { file: 'ggml-small.bin', mb: 466, note: '中文明显更准，CPU 上稍慢' },
  medium: { file: 'ggml-medium.bin', mb: 1500, note: '最准，但需要较强 CPU' },
};

function whisperHome() {
  return path.join(modelDir(), 'whisper');
}

function findBinary() {
  const home = whisperHome();
  const candidates = [
    path.join(home, 'Release', 'whisper-cli.exe'),
    path.join(home, 'whisper-cli.exe'),
    path.join(home, 'bin', 'whisper-cli.exe'),
    path.join(home, 'main.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 兜底：递归找一次
  const stack = [home];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === 'whisper-cli.exe') return p;
    }
  }
  return null;
}

function modelFile(size = 'base') {
  const meta = MODELS[size] || MODELS.base;
  return path.join(whisperHome(), 'models', meta.file);
}

function status() {
  const bin = findBinary();
  const size = 'base';
  return {
    backend: 'whisper',
    binary: bin,
    binaryReady: Boolean(bin),
    home: whisperHome(),
    models: Object.entries(MODELS).map(([k, v]) => ({
      id: k,
      file: v.file,
      mb: v.mb,
      note: v.note,
      ready: fs.existsSync(modelFile(k)),
      path: modelFile(k),
    })),
    availableSizes: Object.keys(MODELS),
  };
}

async function installBinary(onProgress) {
  const home = whisperHome();
  await fsp.mkdir(home, { recursive: true });
  const zip = path.join(tempDir(), 'whisper-bin-x64.zip');
  let lastErr = null;
  for (let i = 0; i < BIN_SOURCES.length; i++) {
    const src = BIN_SOURCES[i];
    const last = i === BIN_SOURCES.length - 1;
    try {
      log.info('下载 whisper.cpp 二进制', src.name, src.url);
      await fsp.rm(zip + '.part', { force: true });
      await download(src.url, zip, {
        onProgress,
        retries: 2,
        timeoutMs: 300000,
        minBps: last ? 0 : MIN_BPS,
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log.warn(`${src.name} 不可用，换下一个`, e.message);
    }
  }
  if (lastErr) throw lastErr;

  await extractZip(zip, home);
  await fsp.rm(zip, { force: true });
  const bin = findBinary();
  if (!bin) throw new Error('解压后没有找到 whisper-cli.exe');
  log.info('whisper 二进制就绪', bin);
  return bin;
}

async function installModel(size = 'base', onProgress) {
  const meta = MODELS[size];
  if (!meta) throw new Error(`未知模型规格：${size}`);
  const dest = modelFile(size);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastErr = null;
  for (let i = 0; i < MODEL_SOURCES.length; i++) {
    const src = MODEL_SOURCES[i];
    const last = i === MODEL_SOURCES.length - 1;
    try {
      log.info(`下载语音模型 ${meta.file}`, src.name);
      await fsp.rm(dest + '.part', { force: true });
      await download(`${src.url}/${meta.file}`, dest, {
        onProgress,
        retries: 2,
        timeoutMs: 0,
        minBps: last ? 0 : MIN_BPS,
        // 一百多 MB 的文件，给足探测时间再判断速度
        probeMs: 20000,
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log.warn(`${src.name} 不可用，换下一个`, e.message);
    }
  }
  if (lastErr) throw lastErr;
  return dest;
}

async function extractZip(zipPath, destDir) {
  // 用系统自带的 tar（Windows 10+ 内置 bsdtar，可解 zip），避免引入解压依赖
  await new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败(${code}) ${err.slice(0, 200)}`))));
  });
}

/** Float32Array（16kHz 单声道，取值 -1~1）写成 16bit PCM WAV */
function writeWav(file, float32) {
  const len = float32.length;
  const buffer = Buffer.alloc(44 + len * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + len * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(16000 * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(len * 2, 40);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buffer.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  return file;
}

/**
 * 识别一段 16kHz 单声道 float 音频。
 * @param {Float32Array|number[]} samples
 * @param {{language?:string, threads?:number, size?:string, prompt?:string, timeoutMs?:number}} opts
 */
async function transcribe(samples, opts = {}) {
  const bin = opts.binPath || findBinary();
  if (!bin) throw new Error('还没有安装本地语音识别组件');
  const size = opts.size || 'base';
  const model = modelFile(size);
  if (!fs.existsSync(model)) throw new Error(`还没有下载语音模型（${size}）`);

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const wav = path.join(tempDir(), `asr_${stamp}.wav`);
  const prefix = path.join(tempDir(), `asr_${stamp}`);
  writeWav(wav, samples instanceof Float32Array ? samples : Float32Array.from(samples));

  const args = [
    '-m',
    model,
    '-f',
    wav,
    '-l',
    opts.language || 'zh',
    '-t',
    String(opts.threads || Math.max(2, Math.min(8, os.cpus().length - 1))),
    '-nt',
    '-otxt',
    '-of',
    prefix,
    '--no-prints',
  ];
  if (opts.prompt) args.push('--prompt', opts.prompt);

  const timeoutMs = opts.timeoutMs || 90000;
  const started = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(bin, args, { windowsHide: true, cwd: path.dirname(bin) });
      let err = '';
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('语音识别超时'));
      }, timeoutMs);
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('error', reject);
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`whisper-cli 退出码 ${code}：${err.slice(-300)}`));
      });
    });

    const txtFile = `${prefix}.txt`;
    let text = '';
    if (fs.existsSync(txtFile)) text = fs.readFileSync(txtFile, 'utf8');
    text = text
      .replace(/\[[\d:.\s\->]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { text, ms: Date.now() - started, model: size };
  } finally {
    fsp.rm(wav, { force: true }).catch(() => {});
    fsp.rm(`${prefix}.txt`, { force: true }).catch(() => {});
  }
}

module.exports = { transcribe, status, installBinary, installModel, findBinary, modelFile, MODELS, whisperHome, writeWav };
