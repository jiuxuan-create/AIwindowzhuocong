'use strict';
/**
 * 名字唤醒判定。
 *
 * 本地 ASR 对专有名词的识别并不稳定，所以这里不要求逐字匹配：
 *  1. 先做归一化（去标点、去空格、简繁近似）；
 *  2. 精确包含即命中；
 *  3. 否则允许「同音/近音」候选与编辑距离 1 的模糊匹配。
 * 命中后把唤醒词从句子中去掉，剩下的当作这一轮的内容。
 */

// 常见同音/近音误识别，用户可以在管理页里继续补充
const DEFAULT_HOMOPHONES = {
  小满: ['小曼', '小蛮', '小漫', '小瞒', '晓满', '筱满', '小馒', '小慢'],
  小满儿: ['小满儿'],
};

const CN_PUNCT = /[\s,，。.!！?？、；;：:"'“”‘’()（）\[\]【】<>《》~～\-—_+*#]/g;

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(CN_PUNCT, '')
    .trim();
}

/** 允许的错字数量：名字越长越宽容，但不超过长度的 1/3 */
function allowedDistance(len) {
  if (len <= 1) return 0;
  if (len === 2) return 1;
  if (len <= 4) return 1;
  return Math.floor(len / 3);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

class WakeWord {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  candidates() {
    const cfg = this.getConfig();
    const pet = cfg.pet || {};
    const names = [pet.name, ...(pet.aliases || [])].filter(Boolean).map((s) => String(s).trim());
    const out = new Set();
    for (const n of names) {
      out.add(n);
      for (const h of DEFAULT_HOMOPHONES[n] || []) out.add(h);
    }
    return [...out];
  }

  /**
   * @param {string} rawText ASR 原文
   * @returns {{matched:boolean, name:string|null, cleaned:string, how:string}}
   */
  match(rawText) {
    const text = String(rawText || '');
    const norm = normalize(text);
    if (!norm) return { matched: false, name: null, cleaned: text, how: 'empty' };

    for (const cand of this.candidates()) {
      const c = normalize(cand);
      if (!c) continue;
      const idx = norm.indexOf(c);
      if (idx >= 0) {
        return {
          matched: true,
          name: cand,
          cleaned: stripByNorm(text, c),
          how: 'exact',
        };
      }
    }

    // 模糊：只看句首一小段，避免句中偶发误命中
    const head = norm.slice(0, 6);
    for (const cand of this.candidates()) {
      const c = normalize(cand);
      if (c.length < 2) continue;
      const win = head.slice(0, c.length + 1);
      for (let i = 0; i + c.length <= win.length; i++) {
        const seg = win.slice(i, i + c.length);
        if (levenshtein(seg, c) <= allowedDistance(c.length)) {
          return { matched: true, name: cand, cleaned: stripByNorm(text, seg), how: 'fuzzy' };
        }
      }
    }
    return { matched: false, name: null, cleaned: text, how: 'none' };
  }
}

/** 把（可能被误识别的）唤醒片段从原句里去掉 */
function stripByNorm(text, normSeg) {
  const chars = Array.from(String(text));
  // 逐个字符扫描，匹配到归一化后的片段就跳过
  let seg = '';
  const skipUntil = [];
  let si = 0;
  for (let i = 0; i < chars.length; i++) {
    const n = normalize(chars[i]);
    if (!n) continue;
    seg += n;
    if (normSeg.startsWith(seg)) {
      if (seg.length === normSeg.length) {
        for (let k = si; k <= i; k++) skipUntil.push(k);
        break;
      }
    } else {
      seg = n;
      si = i;
      if (normSeg.startsWith(seg) && seg.length === normSeg.length) {
        skipUntil.push(i);
        break;
      }
    }
    if (!seg) si = i + 1;
  }
  const out = chars.filter((_, i) => !skipUntil.includes(i)).join('');
  return out.replace(/^[\s,，。.!！?？、]+/, '').trim();
}

module.exports = { WakeWord, normalize, levenshtein };
