'use strict';
/**
 * 本地语音合成。
 *
 * 默认用 Windows 自带的 SAPI（离线、零安装、中文音色随系统提供），
 * 也支持接入任何 OpenAI 兼容的本地 TTS 服务（例如自己起的 GPT-SoVITS、Kokoro）。
 * 返回音频字节而不是直接播放，这样渲染端可以用 AnalyserNode 做口型同步。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir, assetPath } = require('../paths');
const { request, fetchJson } = require('../net');
const { scoped } = require('../logger');

const log = scoped('voice.tts');

const PS = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

function runPowerShell(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('语音合成超时'));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.slice(-400) || `powershell 退出码 ${code}`));
    });
  });
}

class TTS {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.voicesCache = null;
  }

  opts() {
    const c = this.getConfig().voice?.tts || {};
    return {
      backend: c.backend || 'sapi',
      sapiVoice: c.sapiVoice || '',
      rate: typeof c.rate === 'number' ? c.rate : 0,
      volume: typeof c.volume === 'number' ? c.volume : 100,
      baseUrl: (c.baseUrl || '').replace(/\/+$/, ''),
      apiKey: c.apiKey || '',
      model: c.model || '',
      speed: typeof c.speed === 'number' ? c.speed : 1,
    };
  }

  async listVoices() {
    if (this.voicesCache) return this.voicesCache;
    try {
      const out = await runPowerShell(['-File', assetPath('scripts', 'sapi-voices.ps1')], { timeoutMs: 20000 });
      const json = out.trim().split(/\r?\n/).filter(Boolean).pop() || '[]';
      const parsed = JSON.parse(json);
      this.voicesCache = Array.isArray(parsed) ? parsed : [parsed];
      return this.voicesCache;
    } catch (err) {
      log.warn('读取系统音色失败', err.message);
      return [];
    }
  }

  async status() {
    const o = this.opts();
    const base = { backend: o.backend };
    if (o.backend === 'sapi') {
      const voices = await this.listVoices();
      const zh = voices.filter((v) => /^zh/i.test(v.culture));
      return {
        ...base,
        ready: voices.length > 0,
        voices,
        recommended: zh.length ? zh.map((v) => v.name) : voices.map((v) => v.name),
        note: zh.length ? '已找到中文音色' : '系统里没有中文音色，会退回到默认音色',
      };
    }
    if (o.backend === 'openai') {
      return { ...base, ready: Boolean(o.baseUrl), baseUrl: o.baseUrl, model: o.model };
    }
    return { ...base, ready: false, note: '已关闭语音播报' };
  }

  /**
   * @param {string} text
   * @returns {Promise<{buffer:Buffer, mime:string, backend:string, ms:number}>}
   */
  async synthesize(text) {
    const o = this.opts();
    const started = Date.now();
    const clean = String(text || '')
      .replace(/[（(][^）)]{0,40}[）)]/g, '')
      .replace(/[~～]{2,}/g, '')
      .trim()
      .slice(0, 600);
    if (!clean) throw new Error('没有可朗读的内容');

    if (o.backend === 'none') return { buffer: Buffer.alloc(0), mime: 'audio/wav', backend: 'none', ms: 0 };

    if (o.backend === 'openai') {
      if (!o.baseUrl) throw new Error('还没有填写本地语音服务的地址');
      const res = await request(`${o.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: o.model || 'tts-1',
          input: clean,
          voice: o.sapiVoice || 'default',
          speed: o.speed,
          response_format: 'wav',
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`本地语音服务返回 ${res.status} ${t.slice(0, 200)}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, mime: 'audio/wav', backend: 'openai', ms: Date.now() - started };
    }

    // 默认 SAPI
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const textFile = path.join(tempDir(), `tts_${stamp}.txt`);
    const outFile = path.join(tempDir(), `tts_${stamp}.wav`);
    await fsp.writeFile(textFile, clean, 'utf8');
    try {
      await runPowerShell(
        [
          '-File',
          assetPath('scripts', 'sapi-tts.ps1'),
          '-TextFile',
          textFile,
          '-OutFile',
          outFile,
          ...(o.sapiVoice ? ['-Voice', o.sapiVoice] : []),
          '-Rate',
          String(o.rate),
          '-Volume',
          String(o.volume),
        ],
        { timeoutMs: 45000 }
      );
      const buffer = await fsp.readFile(outFile);
      if (!buffer.length) throw new Error('合成结果为空');
      return { buffer, mime: 'audio/wav', backend: 'sapi', ms: Date.now() - started };
    } finally {
      fsp.rm(textFile, { force: true }).catch(() => {});
      fsp.rm(outFile, { force: true }).catch(() => {});
    }
  }
}

module.exports = { TTS };
