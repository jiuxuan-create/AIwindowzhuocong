'use strict';
/**
 * 长期记忆检索。
 *
 * 中文场景下不引入分词依赖：CJK 走字符二元组（bigram），拉丁字母/数字走整词。
 * 打分 = BM25(关键词相关性) × 时间衰减 × 重要度 × 未召回惩罚。
 * 目标是「可解释的召回」：网页端能看到每条记忆为什么被选中。
 */

const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '与', '就', '都', '也', '很',
  '有', '没有', '这', '那', '个', '把', '被', '给', '对', '从', '到', '而', '但', '然后', '因为',
  '所以', '如果', '还是', '就是', '一个', '什么', '怎么', '可以', '会', '要', 'the', 'a', 'an',
  'is', 'are', 'to', 'of', 'and', 'in', 'on', 'for', 'it', 'that', 'this',
]);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  let latin = '';

  const flushLatin = () => {
    if (latin.length >= 2 && !STOPWORDS.has(latin)) tokens.push(latin);
    latin = '';
  };

  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (CJK.test(ch)) {
      flushLatin();
      const next = chars[i + 1];
      if (next && CJK.test(next)) {
        const bi = ch + next;
        if (!STOPWORDS.has(bi)) tokens.push(bi);
      }
      if (!STOPWORDS.has(ch)) tokens.push(ch);
    } else if (/[a-z0-9]/.test(ch)) {
      latin += ch;
    } else {
      flushLatin();
    }
  }
  flushLatin();
  return tokens;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

class Retriever {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.docs = [];
    this.df = new Map();
    this.avgdl = 1;
    this.dirty = true;
  }

  /** 全量重建索引（记忆数量在万级以内，重建成本可接受） */
  build(items) {
    this.docs = (items || []).map((it) => {
      const tokens = termFreq(tokenize(`${it.text} ${(it.keywords || []).join(' ')}`));
      return { item: it, tf: tokens, len: [...tokens.values()].reduce((a, b) => a + b, 0) || 1 };
    });
    this.df = new Map();
    for (const d of this.docs) {
      for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgdl = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1) || 1;
    this.dirty = false;
    return this.docs.length;
  }

  /**
   * @param {string} query 查询文本
   * @param {{topK?:number, minScore?:number, now?:number, kind?:string}} opts
   */
  search(query, opts = {}) {
    const cfg = this.getConfig().memory || {};
    const topK = opts.topK || cfg.retrievalTopK || 6;
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : cfg.minScore ?? 0.1;
    const now = opts.now || Date.now();

    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length || !this.docs.length) return [];

    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.72;

    const scored = [];
    for (const d of this.docs) {
      const item = d.item;
      if (opts.kind && item.kind !== opts.kind) continue;

      let score = 0;
      const matched = [];
      for (const t of qTokens) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = f + k1 * (1 - b + (b * d.len) / this.avgdl);
        const term = idf * ((f * (k1 + 1)) / denom);
        score += term;
        matched.push(t);
      }
      if (score <= 0) continue;

      // 归一化到 0~1 附近，便于展示与阈值判断
      score /= 1 + Math.sqrt(qTokens.length);

      // 时间衰减：45 天半衰期（长期偏好/事实不该因为旧就被完全忽略）
      const ageDays = Math.max(0, (now - (item.ts || now)) / 86400000);
      const recency = Math.pow(0.5, ageDays / 45);
      const salience = 0.6 + (item.salience ?? 0.5) * 0.8;
      const frequentlyRecalled = item.recallCount > 3 ? 0.9 : 1; // 反复出现说明不重要，略微降权

      const final = score * (0.55 + 0.45 * recency) * salience * frequentlyRecalled;
      scored.push({ item, score: final, matched: matched.slice(0, 8) });
    }

    scored.sort((a, b2) => b2.score - a.score);
    return scored.filter((s) => s.score >= minScore).slice(0, topK);
  }

  /** 给网页端看的解释信息 */
  explain(entry) {
    return {
      id: entry.item.id,
      text: entry.item.text,
      score: Number(entry.score.toFixed(3)),
      matched: entry.matched,
    };
  }
}

module.exports = { Retriever, tokenize };
