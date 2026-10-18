'use strict';
/**
 * 语音会话状态机。
 *
 * off     — 没开语音
 * idle    — 被动监听：本地 VAD 只在有人说话时唤醒一次识别，用来判断有没有叫名字
 * active  — 已唤醒，接下来每一句都直接当指令处理
 * busy    — 正在识别/回答
 *
 * 渲染端负责采集与 VAD，这里负责「识别 → 唤醒判定 → 交给对话 → 合成回放」。
 */
const { EventEmitter } = require('node:events');
const { scoped } = require('../logger');
const { WakeWord } = require('./wake');
const whisper = require('./whisper');
const { TTS } = require('./tts');

const log = scoped('voice');

class VoiceService extends EventEmitter {
  constructor({ config, chat }) {
    super();
    this.config = config;
    this.chat = chat;
    this.wake = new WakeWord(() => this.config.all());
    this.tts = new TTS(() => this.config.all());
    this.state = 'off';
    this.activeUntil = 0;
    this.queue = Promise.resolve();
    this.lastUtteranceAt = 0;
  }

  cfg() {
    return this.config.all().voice || {};
  }

  isEnabled() {
    return this.cfg().wake?.enabled === true;
  }

  setState(s, detail = '') {
    this.state = s;
    this.emit('state', { state: s, detail, at: Date.now() });
    log.debug('voice state ->', s, detail);
  }

  /** 进入活跃窗口，之后的句子不需要再叫名字 */
  arm(ms = 120000) {
    this.activeUntil = Date.now() + ms;
  }

  get isActive() {
    return Date.now() < this.activeUntil;
  }

  /**
   * 处理一段语音。
   * @param {{samples:Float32Array, features:object}} payload
   */
  handleUtterance(payload) {
    this.queue = this.queue.then(() => this._handle(payload)).catch((e) => log.error('语音处理失败', e.message));
    return this.queue;
  }

  async _handle({ samples, features }) {
    const cfg = this.cfg();
    if (!samples || samples.length < 1600) return; // 少于 0.1s 直接丢

    const wakeCfg = cfg.wake || {};
    const passive = !this.isActive;

    this.setState('busy', '正在识别');
    const started = Date.now();
    let result;
    try {
      result = await whisper.transcribe(samples, {
        language: cfg.asr?.language || 'zh',
        threads: cfg.asr?.threads,
        size: cfg.asr?.model || 'base',
        prompt: `这是一只在电脑里的桌宠和用户的对话，桌宠叫${this.config.get('pet.name', '小满')}。`,
      });
    } catch (err) {
      this.setState('idle', `识别失败：${err.message}`);
      this.emit('error', { stage: 'asr', message: err.message });
      return;
    }

    const text = (result.text || '').trim();
    this.emit('transcript', { text, ms: result.ms, passive });

    if (!text || text.length < 1) {
      this.setState('idle', '没听清');
      return;
    }
    // whisper 对静音/噪声的常见幻觉输出
    if (/^(请?不?要?订阅|字幕|感谢观看|谢谢观看|字幕组|请点赞|Thanks for watching)/i.test(text)) {
      this.setState('idle', '忽略疑似幻觉输出');
      return;
    }

    let content = text;
    if (passive) {
      if (wakeCfg.requireName === false) {
        // 不需要叫名字时，动到声音就当指令
        this.arm();
      } else {
        const m = this.wake.match(text);
        if (!m.matched) {
          this.setState('idle', `没有听到名字（识别为「${text.slice(0, 12)}」）`);
          return;
        }
        this.arm();
        content = m.cleaned || '';
        this.emit('wake', { name: m.name, how: m.how });
        if (!content || content.length < 2) {
          // 只叫了名字：打个招呼，等下一句
          this.setState('active', '已唤醒');
          this.emit('greeted');
          return;
        }
      }
    }

    this.setState('busy', '正在思考');
    const text2 = content.trim();
    if (!text2) {
      this.setState('idle', '空内容');
      return;
    }

    try {
      const res = await this.chat.send({
        text: text2,
        source: 'voice',
        signals: { acoustic: { ...(features || {}), durationMs: features?.durationMs || result.ms } },
      });
      this.emit('reply', { ...res, transcript: text2, totalMs: Date.now() - started });
      this.setState(this.isEnabled() ? 'active' : 'off', '');
    } catch (err) {
      log.error('对话失败', err.message);
      this.emit('error', { stage: 'chat', message: err.message });
      this.setState('idle', err.message);
    }
  }

  /** 合成并广播音频，渲染端负责播放与口型 */
  async speak(text) {
    const cfg = this.cfg();
    if (cfg.tts?.backend === 'none' || !text) return null;
    try {
      const r = await this.tts.synthesize(text);
      if (!r.buffer.length) return null;
      this.emit('audio', { data: r.buffer, mime: r.mime, backend: r.backend });
      return r;
    } catch (err) {
      log.warn('语音合成失败', err.message);
      this.emit('error', { stage: 'tts', message: err.message });
      return null;
    }
  }
}

module.exports = { VoiceService };
