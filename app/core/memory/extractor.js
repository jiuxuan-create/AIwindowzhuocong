'use strict';
/**
 * 长期记忆抽取。
 * 优先交给大模型做结构化抽取（能识别隐含偏好与关系），
 * 没有 Key 或模型失败时退回本地启发式规则，保证记忆链路不会因为缺少凭据而断掉。
 */
const { scoped } = require('../logger');

const log = scoped('memory.extract');

const EXTRACT_PROMPT = `你是一个记忆整理器。请从对话片段中抽取值得长期记住的信息。

只记录**关于用户本人**的、稳定的信息，例如：
- 事实：职业、学校、所在地、养了什么宠物、在做的项目、身体情况
- 偏好：喜欢/讨厌的东西、说话习惯、作息习惯
- 事件：最近发生的重要事情（有明确时间或状态变化的）
- 关系：提到的人以及和用户的关系

不要记录：寒暄、临时情绪、当次提问本身、桌宠自己的话、任何推测。

输出严格 JSON，不要包含解释或 Markdown：
{"memories":[{"kind":"fact|preference|event|relation","text":"一句中文陈述，主语用「用户」","salience":0.0到1.0的重要度,"keywords":["关键词"]}]}

如果没有值得记录的内容，输出 {"memories":[]}。每次最多 4 条。`;

const RULES = [
  { kind: 'preference', re: /我(?:最|很|挺|超)?(?:喜欢|爱|偏爱|中意)([^\n。！？!?，,]{1,30})/g },
  { kind: 'preference', re: /我(?:最|很|挺|超)?(?:讨厌|不喜欢|受不了|不吃|怕)([^\n。！？!?，,]{1,30})/g },
  { kind: 'fact', re: /我是(?:一?[个名位])?([^\n。！？!?，,]{1,28})/g },
  { kind: 'fact', re: /我在([^\n。！？!?，,]{1,28}?)(?:工作|上班|读书|上学|念书)/g },
  { kind: 'fact', re: /我(?:住|住在|老家)(?:在)?([^\n。！？!?，,]{1,20})/g },
  { kind: 'fact', re: /我(?:养|有)(?:了)?(?:一?[只条个])?([^\n。！？!?，,]{1,16}?)(?:猫|狗|仓鼠|兔子|鱼)/g },
  { kind: 'relation', re: /我(?:老婆|老公|女朋友|男朋友|妈妈|爸爸|女儿|儿子|同事|老板|室友)([^\n。！？!?，,]{0,20})/g },
  { kind: 'event', re: /我(?:昨天|今天|明天|这周|下周|最近|刚|马上要)([^\n。！？!?，,]{1,34})/g },
];

const KIND_PRIORITY = { preference: 0.72, fact: 0.68, relation: 0.66, event: 0.55 };

function localExtract(texts) {
  const out = [];
  const seen = new Set();
  for (const raw of texts) {
    const text = String(raw || '').trim();
    if (!text || text.length > 400) continue;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text))) {
        const frag = (m[0] || '').trim().replace(/[，,。.!！?？]$/, '');
        if (frag.length < 4 || frag.length > 60) continue;
        if (seen.has(frag)) continue;
        seen.add(frag);
        out.push({
          kind: rule.kind,
          text: frag.startsWith('我') ? frag.replace(/^我/, '用户') : frag,
          salience: KIND_PRIORITY[rule.kind] ?? 0.5,
          keywords: [...new Set(extractKeywords(frag))].slice(0, 5),
          origin: 'local-rule',
        });
      }
    }
  }
  return out.slice(0, 4);
}

function extractKeywords(text) {
  const s = String(text);
  const words = s.match(/[\u4e00-\u9fff]{2,4}|[A-Za-z][A-Za-z0-9_+-]{1,}/g) || [];
  const stop = new Set(['用户', '什么', '这个', '那个', '然后', '就是', '因为', '所以', '可以']);
  return words.filter((w) => !stop.has(w));
}

function safeJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

class MemoryExtractor {
  constructor({ llm, store, getConfig }) {
    this.llm = llm;
    this.store = store;
    this.getConfig = getConfig;
    this.busy = false;
  }

  /**
   * 从一批消息里抽取并写入长期记忆。异步调用，失败不影响对话。
   * @param {Array<{id:string, role:string, text:string}>} messages
   */
  async extractFrom(messages) {
    const cfg = this.getConfig();
    if (!cfg.memory?.longTermEnabled || !cfg.memory?.enabled) return [];
    if (this.busy) return [];
    const userTexts = messages.filter((m) => m.role === 'user' && m.text).map((m) => m.text);
    if (!userTexts.length) return [];
    // 太短的寒暄不必走一轮模型
    if (userTexts.join('').replace(/\s/g, '').length < 6) return [];

    this.busy = true;
    try {
      let items = null;
      if (this.llm.isConfigured()) {
        try {
          const raw = await this.llm.complete(
            [
              { role: 'system', content: EXTRACT_PROMPT },
              { role: 'user', content: userTexts.map((t, i) => `${i + 1}. ${t}`).join('\n') },
            ],
            { temperature: 0.2, maxTokens: 500, json: true }
          );
          const parsed = safeJson(raw);
          if (parsed && Array.isArray(parsed.memories)) {
            items = parsed.memories
              .filter((m) => m && typeof m.text === 'string' && m.text.trim().length >= 4)
              .slice(0, 4)
              .map((m) => ({
                kind: ['fact', 'preference', 'event', 'relation'].includes(m.kind) ? m.kind : 'fact',
                text: String(m.text).trim().slice(0, 120),
                salience: typeof m.salience === 'number' ? Math.max(0, Math.min(1, m.salience)) : 0.55,
                keywords: Array.isArray(m.keywords) ? m.keywords.map(String).slice(0, 6) : [],
                origin: 'llm',
              }));
          }
        } catch (err) {
          log.warn('模型抽取失败，改用本地规则', err.message);
        }
      }
      if (!items || !items.length) items = localExtract(userTexts);

      const ids = messages.map((m) => m.id).filter(Boolean);
      const added = [];
      for (const it of items) {
        const rec = this.store.addMemory({ ...it, sourceMessageIds: ids });
        if (rec) added.push(rec);
      }
      if (added.length) log.info(`新增长期记忆 ${added.length} 条`);
      return added;
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { MemoryExtractor, localExtract, safeJson };
