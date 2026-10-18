'use strict';
/**
 * 桌宠自身情绪状态机。
 *
 * 分成三块互相独立、但都会被网页端展示的状态：
 *  - mood    桌宠自己的心情（慢变，向基线回归）
 *  - userMood 对用户情绪的滑动估计（由融合结果指数平滑而来）
 *  - affinity / energy 关系亲密度与精力（影响表现与语气）
 *
 * 这里不做任何 I/O 之外的决策；谁调用它、什么时候调用由 chat 编排层决定。
 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { memoryDir } = require('../paths');
const { scoped } = require('../logger');
const { labelOf, LABEL_ZH } = require('./lexicon');

const log = scoped('emotion.state');
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const BASELINE = { valence: 0.14, arousal: 0.34 };

/** 心情 → Live2D 表现预设（renderer 端按 key 取表情/动作） */
function toExpression(mood, energy) {
  const { valence: v, arousal: a } = mood;
  if (energy < 0.18) return 'tired';
  if (v >= 0.3) {
    if (a >= 0.68) return 'excited';
    if (a <= 0.3) return 'content';
    return 'happy';
  }
  if (v <= -0.3) {
    if (a >= 0.68) return 'angry';
    if (a <= 0.3) return 'sad';
    return 'anxious';
  }
  if (a >= 0.74) return 'surprised';
  if (a <= 0.22) return 'tired';
  return 'calm';
}

class EmotionState extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    this.file = path.join(memoryDir(), 'state.json');
    this.data = this._load();
    this.dirty = false;
    this.lastTick = Date.now();
  }

  _defaults() {
    return {
      mood: { ...BASELINE },
      userMood: { valence: 0, arousal: 0.32 },
      affinity: 0.08,
      energy: 0.85,
      interactions: 0,
      lastInteractionTs: null,
      updatedAt: Date.now(),
    };
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return { ...this._defaults(), ...raw, mood: { ...BASELINE, ...(raw.mood || {}) } };
      }
    } catch (err) {
      log.warn('情绪状态读取失败，使用默认值', err.message);
    }
    return this._defaults();
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    try {
      this.data.updatedAt = Date.now();
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      log.warn('情绪状态写入失败', err.message);
    }
  }

  /** 时间推进：心情回归基线、精力恢复、亲密度轻微回落 */
  tick(now = Date.now()) {
    const dtH = Math.max(0, (now - this.lastTick) / 3600000);
    this.lastTick = now;
    if (dtH <= 0) return this.snapshot();

    const cfg = this.getConfig().memory || {};
    const halfLife = Math.max(0.2, cfg.emotionDecayHalfLifeHours || 18);
    const k = Math.pow(0.5, dtH / halfLife);

    this.data.mood.valence = BASELINE.valence + (this.data.mood.valence - BASELINE.valence) * k;
    this.data.mood.arousal = BASELINE.arousal + (this.data.mood.arousal - BASELINE.arousal) * k;
    this.data.userMood.valence *= k;
    this.data.userMood.arousal = 0.32 + (this.data.userMood.arousal - 0.32) * k;

    const active = this.data.lastInteractionTs && now - this.data.lastInteractionTs < 90_000;
    const regen = active ? -0.06 : 0.12;
    this.data.energy = clamp(this.data.energy + regen * dtH, 0.05, 1);

    this.dirty = true;
    return this.snapshot();
  }

  /** 用融合后的用户情绪更新估计值 */
  observeUser(fused) {
    if (!fused || !fused.confidence) return;
    const alpha = clamp(0.35 + fused.confidence * 0.3, 0.2, 0.8);
    const um = this.data.userMood;
    um.valence = um.valence * (1 - alpha) + fused.valence * alpha;
    um.arousal = um.arousal * (1 - alpha) + fused.arousal * alpha;
    this.dirty = true;
  }

  /**
   * 一次交互后更新桌宠心情。
   * @param {{userValence?:number, kindness?:number, kind?:string}} ev
   */
  react(ev = {}) {
    const cfg = this.getConfig().emotion || {};
    const gain = (cfg.affinityGainPerTurn || 0.35) / 100;

    // 共情：用户开心时桌宠跟着上扬，用户低落时轻微下沉并升高唤醒（担心）
    const uv = typeof ev.userValence === 'number' ? ev.userValence : this.data.userMood.valence;
    let dv = uv * 0.16;
    let da = 0;

    switch (ev.kind) {
      case 'praise':
        dv += 0.14;
        da += 0.06;
        break;
      case 'insult':
        dv -= 0.18;
        da += 0.12;
        break;
      case 'pet': // 摸头/点击
        dv += 0.06;
        da += 0.03;
        break;
      case 'idle':
        break;
      case 'feed':
        dv += 0.1;
        break;
      default:
        dv += 0.015;
    }
    if (typeof ev.kindness === 'number') dv += ev.kindness * 0.12;

    this.data.mood.valence = clamp(
      BASELINE.valence + (this.data.mood.valence - BASELINE.valence) * 0.8 + dv,
      -1,
      1
    );
    // 唤醒度不能被每次都加一个常数：那样不动点会跑到 1 以上，
    // 桌宠会永远钉在「兴奋/惊讶」上。这里改成向一个「在线」目标值松弛。
    const arousalTarget = clamp(0.46 + da + uv * 0.06, 0.05, 1);
    this.data.mood.arousal = clamp(
      this.data.mood.arousal * 0.85 + arousalTarget * 0.15,
      0.05,
      1
    );
    this.data.affinity = clamp(this.data.affinity + gain, 0, 1);
    this.data.energy = clamp(this.data.energy - 0.004, 0.05, 1);
    this.data.interactions += 1;
    this.data.lastInteractionTs = Date.now();
    this.dirty = true;
    this.save();
    return this.snapshot();
  }

  /** 桌宠主动表现时的情绪微调（例如被吵醒、被打断） */
  nudge(dv, da, reason) {
    this.data.mood.valence = clamp(this.data.mood.valence + dv, -1, 1);
    this.data.mood.arousal = clamp(this.data.mood.arousal + da, 0.05, 1);
    if (reason) log.debug('nudge', reason, dv, da);
    this.dirty = true;
  }

  reset() {
    this.data = this._defaults();
    this.lastTick = Date.now();
    this.save(true);
    return this.snapshot();
  }

  snapshot() {
    const mood = { ...this.data.mood };
    const energy = this.data.energy;
    const moodLabel = labelOf(mood.valence, mood.arousal);
    const userMoodLabel = labelOf(this.data.userMood.valence, this.data.userMood.arousal);
    return {
      mood,
      userMood: { ...this.data.userMood },
      moodLabel,
      moodLabelZh: LABEL_ZH[moodLabel] || moodLabel,
      userMoodLabel,
      userMoodLabelZh: LABEL_ZH[userMoodLabel] || userMoodLabel,
      affinity: this.data.affinity,
      energy,
      interactions: this.data.interactions,
      lastInteractionTs: this.data.lastInteractionTs,
      expression: toExpression(mood, energy),
      updatedAt: this.data.updatedAt,
    };
  }
}

module.exports = { EmotionState, toExpression, BASELINE };
