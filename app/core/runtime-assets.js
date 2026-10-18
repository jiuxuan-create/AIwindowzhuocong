'use strict';
/**
 * 运行时资源管理（应用内可一键下载）。
 * 与 scripts/fetch-runtime.mjs 做同样的事，但走 Electron 网络栈、带进度事件，
 * 让用户不用离开管理页就能补齐语音识别与面部情绪模型。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { modelDir, tempDir } = require('./paths');
const { download } = require('./net');
const { scoped } = require('./logger');
const whisper = require('./voice/whisper');

const log = scoped('runtime-assets');

const FACE_SOURCES = [
  // jsdelivr 在国内通常比 storage.googleapis.com 快，所以放前面
  { url: 'https://cdn.jsdelivr.net/gh/google-ai-edge/mediapipe-samples@main/examples/face_landmarker/js/face_landmarker.task', name: 'jsdelivr 镜像' },
  { url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', name: 'Google 官方源' },
];

function faceModelPath() {
  return path.join(modelDir(), 'mediapipe', 'face_landmarker.task');
}

function faceStatus() {
  const p = faceModelPath();
  let ready = false;
  let size = 0;
  try {
    size = fs.statSync(p).size;
    ready = size > 1024 * 1024;
  } catch {
    ready = false;
  }
  return { ready, path: p, bytes: size, mb: 3.7 };
}

function ffmpegAvailable() {
  return new Promise((resolve) => {
    const p = spawn('where', ['ffmpeg'], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

class RuntimeAssets extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
  }

  status() {
    return {
      modelDir: modelDir(),
      whisper: whisper.status(),
      face: faceStatus(),
    };
  }

  progress() {
    return [...this.jobs.values()];
  }

  _job(id, label) {
    const job = { id, label, state: 'running', percent: 0, received: 0, total: 0, message: '', startedAt: Date.now() };
    this.jobs.set(id, job);
    const update = (patch) => {
      Object.assign(job, patch);
      job.percent = job.total ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0;
      this.emit('progress', job);
    };
    return {
      job,
      onProgress: ({ received, total }) => update({ received, total }),
      fail: (msg) => {
        update({ state: 'error', message: msg });
        setTimeout(() => this.jobs.delete(id), 60000);
      },
      done: (msg) => {
        update({ state: 'done', percent: 100, message: msg || '完成' });
        setTimeout(() => this.jobs.delete(id), 20000);
      },
    };
  }

  get running() {
    return [...this.jobs.values()].some((j) => j.state === 'running');
  }

  /** 下载 whisper 二进制（如果还没有） */
  async ensureWhisperBinary() {
    if (whisper.findBinary()) return whisper.findBinary();
    const j = this._job('whisper-bin', '本地语音识别组件');
    try {
      const bin = await whisper.installBinary(j.onProgress);
      j.done('语音识别组件已就绪');
      return bin;
    } catch (e) {
      j.fail(e.message);
      throw e;
    }
  }

  /** 下载指定规格的 ggml 模型 */
  async ensureWhisperModel(size = 'base') {
    const p = whisper.modelFile(size);
    if (fs.existsSync(p) && fs.statSync(p).size > 10 * 1024 * 1024) return p;
    const j = this._job(`whisper-model-${size}`, `语音模型 ${size}`);
    try {
      const out = await whisper.installModel(size, j.onProgress);
      j.done('语音模型已就绪');
      return out;
    } catch (e) {
      j.fail(e.message);
      throw e;
    }
  }

  async ensureFaceModel() {
    if (faceStatus().ready) return faceModelPath();
    const j = this._job('face-model', '面部情绪模型');
    const dest = faceModelPath();
    let lastErr = null;
    for (let i = 0; i < FACE_SOURCES.length; i++) {
      const src = FACE_SOURCES[i];
      const last = i === FACE_SOURCES.length - 1;
      try {
        await fsp.rm(dest + '.part', { force: true }).catch(() => {});
        await download(src.url, dest, {
          onProgress: j.onProgress,
          retries: 2,
          timeoutMs: 300000,
          stallMs: 45000,
          minBps: last ? 0 : 80 * 1024,
        });
        j.done('面部情绪模型已就绪');
        return dest;
      } catch (e) {
        lastErr = e;
        log.warn(`${src.name} 不可用，换下一个`, e.message);
      }
    }
    j.fail(lastErr ? lastErr.message : '下载失败');
    throw lastErr || new Error('下载失败');
  }

  /** 一次性把语音链路要的东西都装好 */
  async installSpeech(size = 'base') {
    await this.ensureWhisperBinary();
    await this.ensureWhisperModel(size);
    await fsp.rm(path.join(tempDir(), 'whisper-bin-x64.zip'), { force: true }).catch(() => {});
    return this.status();
  }

  /** 删除已下载的语音资源，释放空间 */
  async removeSpeech() {
    const home = whisper.whisperHome();
    await fsp.rm(home, { recursive: true, force: true });
    return this.status();
  }
}

module.exports = { RuntimeAssets, faceModelPath, faceStatus };
