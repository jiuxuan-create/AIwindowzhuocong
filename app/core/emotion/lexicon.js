'use strict';
/**
 * 中文情绪词典与轻量打分。
 * 用途：在没有大模型可用时给文本情绪兜底，也给声学/视觉信号提供统一的词汇锚点。
 * 不追求覆盖度，追求「不误判、可解释」。
 */

// 情绪词（正向）
const POSITIVE = {
  // 词: 强度 0.3~1.0
  开心: 0.8, 高兴: 0.8, 快乐: 0.8, 愉快: 0.7, 舒服: 0.6, 幸福: 0.9, 满足: 0.6, 满意: 0.5,
  兴奋: 0.9, 激动: 0.8, 期待: 0.6, 期待已久: 0.8, 惊喜: 0.9, 太棒: 0.9, 棒: 0.6, 好棒: 0.8,
  喜欢: 0.7, 爱: 0.8, 最爱: 0.9, 心疼: 0.4, 感动: 0.7, 温暖: 0.6, 安心: 0.6, 放心: 0.5,
  不错: 0.4, 很好: 0.6, 挺好: 0.5, 真好: 0.7, 好耶: 0.8, 太赞: 0.8, 赞: 0.5, 优秀: 0.6,
  感谢: 0.6, 谢谢: 0.5, 辛苦: 0.3, 干得好: 0.6, 厉害: 0.6, 牛: 0.5, 加油: 0.4,
  放松: 0.5, 轻松: 0.5, 解压: 0.6, 治愈: 0.7, 可爱: 0.6, 好看: 0.5, 漂亮: 0.5, 帅: 0.5,
  成功: 0.7, 通过了: 0.7, 完成了: 0.6, 搞定了: 0.7, 顺利: 0.5, 幸运: 0.6, 赚了: 0.6,
  哈哈哈: 0.7, 哈哈: 0.6, 嘿嘿: 0.5, 嘻嘻: 0.5, hhh: 0.6, 笑死: 0.7, 好笑: 0.6, 有意思: 0.5,
  想你了: 0.7, 抱抱: 0.6, 摸摸: 0.5, 陪你: 0.5, 在一起: 0.7, 乖: 0.4,
};

// 情绪词（负向）
const NEGATIVE = {
  难过: 0.8, 伤心: 0.9, 难受: 0.8, 痛苦: 0.9, 委屈: 0.7, 失落: 0.7, 沮丧: 0.8, 郁闷: 0.7,
  烦躁: 0.7, 烦: 0.6, 生气: 0.8, 愤怒: 0.9, 火大: 0.8, 讨厌: 0.7, 恶心: 0.8, 厌恶: 0.8,
  焦虑: 0.8, 紧张: 0.7, 害怕: 0.8, 恐惧: 0.9, 担心: 0.6, 不安: 0.7, 压力: 0.7, 压力大: 0.8,
  累: 0.6, 好累: 0.8, 疲惫: 0.8, 困: 0.5, 撑不住: 0.9, 崩溃: 0.9, 累了: 0.7, 心累: 0.8,
  孤独: 0.7, 寂寞: 0.7, 孤单: 0.7, 没人: 0.5, 想哭: 0.9, 哭: 0.8, 眼泪: 0.7, 心疼死: 0.8,
  失败: 0.7, 搞砸: 0.8, 出错: 0.6, 被骂: 0.8, 挨批: 0.7, 扣钱: 0.7, 亏了: 0.7, 加班: 0.6,
  吵架: 0.7, 分手: 0.9, 绝交: 0.8, 误会: 0.6, 冷淡: 0.5, 被拒: 0.8, 拒绝: 0.5,
  生病: 0.7, 疼: 0.7, 头痛: 0.6, 失眠: 0.7, 熬夜: 0.5, 发烧: 0.7,
  不行: 0.4, 讨厌死了: 0.9, 糟糕: 0.7, 倒霉: 0.7, 无语: 0.5, 无奈: 0.5, 绝望: 1.0,
  加油吧: 0.2, 算了: 0.4, 随便: 0.3, 无所谓: 0.3, 麻木: 0.6,
};

const NEGATIONS = ['不', '没', '无', '别', '非', '未', '莫', '勿', '不是', '没有', '并不', '不太', '不怎么', '一点也不'];
const INTENSIFIERS = {
  很: 1.3, 好: 1.25, 非常: 1.6, 特别: 1.5, 太: 1.6, 超级: 1.7, 极其: 1.8, 真的: 1.35, 真是: 1.35,
  有点: 0.65, 稍微: 0.6, 略: 0.55, 一点: 0.6, 有些: 0.7, 挺: 1.15, 蛮: 1.15, 巨: 1.7, 贼: 1.5,
};
const DIMINISHERS = ['还是', '可能', '好像', '似乎', '大概'];

const QUESTION_WORDS = ['吗', '呢', '?', '？', '怎么', '为什么', '如何', '什么'];

/**
 * 对一段文本做情绪打分。
 * @returns {{valence:number, arousal:number, hits:string[], intensity:number}}
 *   valence ∈ [-1,1]，arousal ∈ [0,1]
 */
function scoreText(text) {
  const src = String(text || '');
  if (!src.trim()) return { valence: 0, arousal: 0.2, hits: [], intensity: 0 };

  const hits = [];
  let pos = 0;
  let neg = 0;

  for (const [word, w] of Object.entries(POSITIVE)) {
    let idx = src.indexOf(word);
    while (idx >= 0) {
      const mult = modifierAt(src, idx);
      const negated = isNegated(src, idx);
      const score = w * mult * (negated ? -0.85 : 1);
      if (score > 0) pos += score;
      else neg += -score;
      hits.push(`${word}${negated ? '(否定)' : ''}`);
      idx = src.indexOf(word, idx + word.length);
    }
  }
  for (const [word, w] of Object.entries(NEGATIVE)) {
    let idx = src.indexOf(word);
    while (idx >= 0) {
      const mult = modifierAt(src, idx);
      const negated = isNegated(src, idx);
      const score = w * mult * (negated ? -0.8 : 1);
      if (score > 0) neg += score;
      else pos += -score;
      hits.push(`${word}${negated ? '(否定)' : ''}`);
      idx = src.indexOf(word, idx + word.length);
    }
  }

  // 标点与表情提供的唤醒度线索
  const exclam = (src.match(/[!！]/g) || []).length;
  const ellipsis = (src.match(/…|\.\.\.|。。。/g) || []).length;
  const laughs = (src.match(/哈{2,}|嘿{2,}|嘻{2,}|hhh+/gi) || []).length;
  const repeated = /([啊呀哦欸嗯呜])\1{1,}/.test(src);

  const raw = pos - neg;
  const magnitude = pos + neg;
  // 压缩到 [-1,1]，多点命中时饱和更快
  const valence = magnitude > 0 ? Math.tanh(raw / Math.max(1.6, magnitude * 0.55)) : 0;

  let arousal = 0.22 + Math.min(0.5, magnitude * 0.16);
  arousal += Math.min(0.18, exclam * 0.07);
  arousal += laughs * 0.08;
  arousal += repeated ? 0.06 : 0;
  arousal -= Math.min(0.12, ellipsis * 0.05);
  if (QUESTION_WORDS.some((q) => src.includes(q))) arousal += 0.04;
  if (/^[\s\S]{0,6}$/.test(src.trim())) arousal -= 0.05; // 极短回复通常偏低唤醒

  return {
    valence: clamp(valence, -1, 1),
    arousal: clamp(arousal, 0.05, 1),
    hits: hits.slice(0, 12),
    intensity: clamp(magnitude / 3, 0, 1),
  };
}

function modifierAt(src, idx) {
  const before = src.slice(Math.max(0, idx - 3), idx);
  let mult = 1;
  for (const [word, m] of Object.entries(INTENSIFIERS)) {
    if (before.endsWith(word)) mult = Math.max(mult, m);
  }
  for (const d of DIMINISHERS) {
    if (before.endsWith(d)) mult = Math.min(mult, 0.85);
  }
  return mult;
}

function isNegated(src, idx) {
  const before = src.slice(Math.max(0, idx - 4), idx);
  return NEGATIONS.some((n) => before.endsWith(n));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 把 (valence, arousal) 映射成可读情绪标签 */
function labelOf(valence, arousal) {
  if (valence >= 0.28) {
    if (arousal >= 0.68) return 'excited'; // 兴奋
    if (arousal <= 0.32) return 'content'; // 满足
    return 'happy'; // 开心
  }
  if (valence <= -0.28) {
    if (arousal >= 0.68) return 'angry'; // 生气
    if (arousal <= 0.3) return 'sad'; // 低落
    return 'anxious'; // 焦虑
  }
  if (arousal >= 0.72) return 'surprised'; // 惊讶
  if (arousal <= 0.24) return 'tired'; // 疲惫
  return 'calm'; // 平静
}

const LABEL_ZH = {
  happy: '开心',
  excited: '兴奋',
  content: '满足',
  calm: '平静',
  sad: '低落',
  anxious: '焦虑',
  angry: '生气',
  surprised: '惊讶',
  tired: '疲惫',
  shy: '害羞',
  neutral: '没特别的感觉',
};

/** 描述给模型看的自然语言（不直接复述给用户） */
const LABEL_HINT = {
  happy: '用户心情不错',
  excited: '用户情绪高昂、很兴奋',
  content: '用户比较放松满足',
  calm: '用户情绪平稳',
  sad: '用户有些低落',
  anxious: '用户有点焦虑不安',
  angry: '用户带着火气',
  surprised: '用户有点意外',
  tired: '用户听起来很疲惫',
  shy: '用户有点不好意思',
  neutral: '用户情绪中性',
};

module.exports = { scoreText, labelOf, LABEL_ZH, LABEL_HINT, POSITIVE, NEGATIVE };
