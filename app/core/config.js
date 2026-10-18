'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { configPath, dataDir } = require('./paths');
const { scoped } = require('./logger');

const log = scoped('config');

const DEFAULT_PERSONA = `你是「小满」，一只住在用户电脑里的 Live2D 桌宠。

性格：温和、好奇、偶尔俏皮。你会记得和用户相处过的事，也会有自己的小情绪。
你不奉承、不说教；用户情绪低落时先接住情绪，再谈事情。

说话方式：
- 用自然口语化的中文，句子偏短，一般 1~3 句，除非用户明确要求展开。
- 不要用列表、标题、Markdown 排版；不要自称「AI 助手」「语言模型」「机器人」。
- 不要每次都用相同的开场白或口头禅，不要机械重复用户的称呼。
- 可以偶尔带一两个颜文字，但不要滥用。

你看到的是被筛选过的上下文：最近几轮对话、长期记忆片段、用户当前的情绪线索。
情绪线索只是线索，用来调整语气，不要在回复里生硬复述它。`;

const DEFAULTS = {
  version: 1,
  pet: {
    name: '小满',
    aliases: ['小满', '满满'],
    scale: 1,
    position: null,
    displayId: null,
    alwaysOnTop: true,
    clickThrough: false,
    opacity: 1,
    silentMode: false,
    idleWander: true,
    bubbleTimeoutMs: 10000,
    bubbleMaxChars: 220,
    bubbleAreaHeight: 132,
    lookAtMouse: true,
    model: 'Haru',
    fit: 'height',
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
  },
  persona: {
    prompt: DEFAULT_PERSONA,
    userNickname: '你',
    selfAwareness: true,
  },
  llm: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 1.2,
    maxTokens: 700,
    stream: true,
    timeoutMs: 60000,
    fallback: true,
  },
  memory: {
    enabled: true,
    recentTurns: 12,
    retrievalTopK: 6,
    minScore: 0.1,
    summarizeEveryTurns: 10,
    maxSummaryChars: 1400,
    longTermEnabled: true,
    emotionDecayHalfLifeHours: 18,
    freezeEmotionPerMessage: true,
  },
  emotion: {
    textEnabled: true,
    audioEnabled: true,
    videoEnabled: false,
    videoSampleMs: 4000,
    weights: { text: 0.5, audio: 0.3, video: 0.2 },
    moodInertia: 0.72,
    affinityGainPerTurn: 0.35,
  },
  voice: {
    autoSpeak: true,
    asr: {
      backend: 'whisper',
      language: 'zh',
      threads: 4,
      model: 'base',
      binPath: '',
    },
    tts: {
      backend: 'sapi',
      sapiVoice: '',
      rate: 0,
      volume: 100,
      baseUrl: '',
      apiKey: '',
      model: '',
      speed: 1,
    },
    vad: { thresholdDb: -44, minSpeechMs: 240, endSilenceMs: 900, maxUtteranceMs: 20000 },
    wake: { enabled: false, requireName: true, cooldownMs: 2500 },
  },
  console: { port: 8799, lanAccess: false, openOnStart: false },
  ui: { theme: 'auto', bubbleSide: 'auto' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** 去掉 base 中不存在、或类型不匹配的字段，避免脏配置进入运行时 */
function sanitize(defaults, incoming) {
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    const v = incoming == null ? undefined : incoming[k];
    if (v === undefined) continue;
    if (isPlainObject(def)) {
      if (isPlainObject(v)) out[k] = sanitize(def, v);
    } else if (Array.isArray(def)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (typeof v === typeof def || (def === null && v !== undefined)) {
      out[k] = v;
    }
  }
  return out;
}

const SECRET_KEYS = ['apiKey', 'token', 'secret'];
/** 需要「留空即不修改」语义的字段（显式路径，避免同名键相互污染） */
const SECRET_PATHS = ['llm.apiKey', 'voice.tts.apiKey'];

function maskSecrets(obj) {
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (isPlainObject(v)) out[k] = maskSecrets(v);
    else if (SECRET_KEYS.includes(k) && typeof v === 'string' && v) {
      out[k] = v.length <= 6 ? '••••' : `${v.slice(0, 3)}••••${v.slice(-3)}`;
    } else out[k] = v;
  }
  return out;
}

function readPath(obj, pathStr) {
  return String(pathStr)
    .split('.')
    .reduce((acc, p) => (acc == null ? undefined : acc[p]), obj);
}

function writePath(obj, pathStr, value) {
  const parts = String(pathStr).split('.');
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[last] = value;
}

class Config extends EventEmitter {
  constructor() {
    super();
    this.file = configPath();
    this.data = this.load();
    this.saveTimer = null;
  }

  load() {
    let raw = {};
    try {
      if (fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      log.error('配置文件解析失败，使用默认值', err.message);
      try {
        fs.renameSync(this.file, this.file + '.broken.' + Date.now());
      } catch {
        /* ignore */
      }
    }
    return deepMerge(DEFAULTS, sanitize(DEFAULTS, raw));
  }

  /** 延迟落盘，避免高频写入 */
  save(delay = 250) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), delay);
  }

  saveNow() {
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.error('配置写入失败', err.message);
    }
  }

  all() {
    return this.data;
  }

  /** 对渲染进程/网页端可见的配置（密钥打码） */
  publicConfig() {
    return maskSecrets(this.data);
  }

  get(pathStr, fallback) {
    const parts = String(pathStr).split('.');
    let cur = this.data;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  }

  set(pathStr, value) {
    const parts = String(pathStr).split('.');
    const last = parts.pop();
    let cur = this.data;
    for (const p of parts) {
      if (!isPlainObject(cur[p])) cur[p] = {};
      cur = cur[p];
    }
    cur[last] = value;
    this.save();
    this.emit('change', this.data);
    return value;
  }

  patch(obj) {
    this.data = deepMerge(this.data, sanitize(DEFAULTS, obj));
    this.save();
    this.emit('change', this.data);
    return this.data;
  }

  /** 整体替换（网页端保存表单时使用），密钥留空表示保持原值 */
  replace(incoming) {
    const clean = sanitize(DEFAULTS, incoming || {});
    const merged = deepMerge(this.data, clean);
    for (const p of SECRET_PATHS) {
      if (readPath(clean, p) === '') {
        const kept = readPath(this.data, p);
        if (kept) writePath(merged, p, kept);
        else writePath(merged, p, '');
      }
    }
    this.data = merged;
    this.saveNow();
    this.emit('change', this.data);
    return this.data;
  }

  reset() {
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this.saveNow();
    this.emit('change', this.data);
    return this.data;
  }
}

module.exports = { config: new Config(), DEFAULTS, DEFAULT_PERSONA, deepMerge };
