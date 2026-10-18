'use strict';
/**
 * 多源情绪融合。
 *
 * 三路信号：文本（对话内容）、声学（语速/音高/能量）、视觉（面部表情）。
 * 每路各自给出 valence/arousal 与置信度，融合时按「置信度 × 配置权重」加权，
 * 并在每路内部先做一次软压缩，避免单路异常值把结果带偏。
 */
const { labelOf } = require('./lexicon');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function soft(v, k = 1) {
  return Math.tanh(v * k);
}

function makeSignal(valence, arousal, confidence, extra = {}) {
  return {
    valence: clamp(valence, -1, 1),
    arousal: clamp(arousal, 0, 1),
    confidence: clamp(confidence, 0, 1),
    ...extra,
  };
}

/**
 * 声学特征 → 情绪。
 * @param {{rmsDb?:number, pitchMean?:number, pitchVar?:number, speechRate?:number,
 *          pauseRatio?:number, durationMs?:number, voicedRatio?:number}} f
 */
function fromAcoustic(f = {}) {
  const {
    rmsDb = -45,
    pitchMean = 0,
    pitchVar = 0,
    speechRate = 0,
    pauseRatio = 0.4,
    durationMs = 0,
    voicedRatio = 0.5,
  } = f;

  if (!durationMs || durationMs < 250 || voicedRatio < 0.06) {
    return makeSignal(0, 0.3, 0.05, { reason: '有效语音过短' });
  }

  // 能量：-50dB(很轻) ~ -18dB(很响)
  const energy = clamp((rmsDb + 50) / 32, 0, 1);
  // 音高：整体越高越偏唤醒；相对基线的变化也计入
  const pitchLevel = pitchMean > 0 ? clamp((pitchMean - 140) / 180, 0, 1) : 0.4;
  const pitchMotion = clamp(pitchVar / 60, 0, 1);
  // 语速：字/秒，2.5 以下偏慢，6 以上偏快
  const rate = speechRate > 0 ? clamp((speechRate - 2.5) / 3.5, 0, 1) : 0.4;
  // 停顿多 → 迟疑/低落
  const hesitant = clamp((pauseRatio - 0.35) / 0.45, 0, 1);

  let arousal = 0.18 + energy * 0.34 + pitchMotion * 0.2 + rate * 0.2 + pitchLevel * 0.12;
  arousal -= hesitant * 0.16;
  arousal = clamp(arousal, 0.05, 1);

  // 声学本身对效价不敏感，只能给出弱线索：
  // 高能量 + 高音高变化 → 偏正向；低能量 + 低音高 + 多停顿 → 偏负向
  let valence = 0;
  valence += (energy - 0.5) * 0.55;
  valence += (pitchMotion - 0.4) * 0.35;
  valence -= hesitant * 0.5;
  valence -= (1 - energy) * (1 - rate) * 0.2;
  valence = clamp(soft(valence, 1.15), -1, 1);

  const confidence = clamp(0.32 + voicedRatio * 0.3 + Math.min(0.28, durationMs / 12000), 0.15, 0.8);
  return makeSignal(valence, arousal, confidence, {
    features: { energy, pitchLevel, pitchMotion, rate, hesitant },
  });
}

/**
 * MediaPipe FaceLandmarker blendshape → 情绪。
 * @param {Record<string, number>} bs 形如 { mouthSmileLeft: 0.6, ... }
 */
function fromVisual(bs = {}) {
  const g = (...keys) => {
    const vals = keys.map((k) => Number(bs[k]) || 0);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  const smile = g('mouthSmileLeft', 'mouthSmileRight');
  const cheek = g('cheekSquintLeft', 'cheekSquintRight');
  const browDown = g('browDownLeft', 'browDownRight');
  const browInner = Number(bs.browInnerUp) || 0;
  const squint = g('eyeSquintLeft', 'eyeSquintRight');
  const wide = g('eyeWideLeft', 'eyeWideRight');
  const jawOpen = Number(bs.jawOpen) || 0;
  const frown = g('mouthFrownLeft', 'mouthFrownRight');
  const press = g('mouthPressLeft', 'mouthPressRight');
  const dimple = g('mouthDimpleLeft', 'mouthDimpleRight');

  const activity =
    smile + cheek + browDown + browInner + squint + wide + jawOpen + frown + press + dimple;
  if (activity < 0.12) return makeSignal(0, 0.3, 0.05, { reason: '面部表情不明确' });

  let valence = 0;
  valence += smile * 1.5 + cheek * 0.6 + dimple * 0.5;
  valence -= frown * 1.3 + press * 0.5 + browDown * 0.7;

  let arousal = 0.15;
  arousal += wide * 0.8 + jawOpen * 0.55 + browInner * 0.6 + browDown * 0.45 + smile * 0.3;
  arousal = clamp(arousal, 0.05, 1);

  const confidence = clamp(0.25 + activity * 0.9, 0.15, 0.85);
  return makeSignal(clamp(soft(valence, 1.0), -1, 1), arousal, confidence, {
    features: { smile, browDown, browInner, jawOpen, wide, frown },
  });
}

/** 文本路（来自词典或大模型） */
function fromText(t) {
  if (!t) return makeSignal(0, 0.3, 0.05, { reason: '没有文本信号' });
  return makeSignal(t.valence, t.arousal, t.confidence ?? 0.55, { hits: t.hits || [] });
}

/**
 * 融合。
 * @param {{text?:object, acoustic?:object, visual?:object}} signals 已归一化的三路信号
 * @param {{weights?:object, enabled?:object, previous?:object, inertia?:number}} opts
 */
function fuse(signals, opts = {}) {
  const weights = { text: 0.5, audio: 0.3, video: 0.2, ...(opts.weights || {}) };
  const enabled = { text: true, audio: true, video: false, ...(opts.enabled || {}) };

  const parts = [];
  if (enabled.text && signals.text) parts.push({ name: 'text', s: signals.text, w: weights.text });
  if (enabled.audio && signals.acoustic) parts.push({ name: 'acoustic', s: signals.acoustic, w: weights.audio });
  if (enabled.video && signals.visual) parts.push({ name: 'visual', s: signals.visual, w: weights.video });

  const usable = parts.filter((p) => p.s && p.s.confidence > 0.04);
  if (!usable.length) {
    const prev = opts.previous || { valence: 0, arousal: 0.3 };
    return {
      valence: prev.valence,
      arousal: prev.arousal,
      label: labelOf(prev.valence, prev.arousal),
      confidence: 0,
      sources: {},
      reason: '没有可用情绪信号',
    };
  }

  let wsum = 0;
  let v = 0;
  let a = 0;
  const sources = {};
  for (const p of usable) {
    const w = Math.max(0.0001, p.w) * p.s.confidence;
    wsum += w;
    v += p.s.valence * w;
    a += p.s.arousal * w;
    sources[p.name] = {
      weight: Number(w.toFixed(3)),
      valence: Number(p.s.valence.toFixed(3)),
      arousal: Number(p.s.arousal.toFixed(3)),
      confidence: Number(p.s.confidence.toFixed(3)),
      ...(p.s.features ? { features: p.s.features } : {}),
      ...(p.s.hits && p.s.hits.length ? { hits: p.s.hits } : {}),
      ...(p.s.reason ? { reason: p.s.reason } : {}),
    };
  }
  v /= wsum;
  a /= wsum;

  // 与上一状态做惯性平滑，避免情绪随单句话剧烈抖动
  const inertia = typeof opts.inertia === 'number' ? opts.inertia : 0;
  if (opts.previous && inertia > 0) {
    v = opts.previous.valence * inertia + v * (1 - inertia);
    a = opts.previous.arousal * inertia + a * (1 - inertia);
  }

  v = clamp(soft(v, 0.9), -1, 1);
  a = clamp(a, 0.05, 1);

  const confidence = clamp(wsum / (usable.reduce((s, p) => s + Math.max(0.0001, p.w), 0) || 1), 0, 1);

  return {
    valence: v,
    arousal: a,
    label: labelOf(v, a),
    confidence: Number(confidence.toFixed(3)),
    sources,
    activeSources: usable.map((p) => p.name),
  };
}

module.exports = { fuse, fromAcoustic, fromVisual, fromText, makeSignal, soft, clamp };
