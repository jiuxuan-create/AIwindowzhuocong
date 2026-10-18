'use strict';
/**
 * 滚动摘要。
 * 当「上次摘要之后」积累的对话超过阈值时，把这一段压成一段文字摘要，
 * 并与上一版摘要合并，保证摘要始终覆盖到最近，同时长度可控。
 */
const { scoped } = require('../logger');

const log = scoped('memory.summarizer');

const PROMPT = `你在维护一段长期陪伴关系的对话记忆。

把下面这段对话压缩成一段摘要，供之后的对话参考。要求：
- 用第三人称，以「用户」和「桌宠」称呼双方。
- 保留：用户说过的重要事实、偏好、情绪状态与转折、正在做的事、约定或承诺。
- 丢弃：寒暄、重复内容、桌宠的修饰性表达。
- 不要出现「本段对话」「以下是」这类元话术，直接写内容本身。
- 中文，不超过 220 字。`;

class Summarizer {
  constructor({ llm, store, getConfig }) {
    this.llm = llm;
    this.store = store;
    this.getConfig = getConfig;
    this.busy = false;
    this.sinceLast = 0;
  }

  /** 记录新消息，达到阈值时返回 true 表示该生成摘要了 */
  tick() {
    this.sinceLast += 1;
    const every = this.getConfig().memory?.summarizeEveryTurns || 10;
    return this.sinceLast >= every;
  }

  async maybeSummarize() {
    const cfg = this.getConfig();
    if (!cfg.memory?.enabled) return null;
    const every = cfg.memory?.summarizeEveryTurns || 10;
    const pending = this.store.messages.slice(-Math.max(every, this.sinceLast));
    const lastSummary = this.store.latestSummary();
    const fresh = lastSummary
      ? pending.filter((m) => (m.ts || 0) >= (lastSummary.toTs || 0) + 1)
      : pending;
    if (fresh.length < Math.min(4, every)) return null;
    return this.summarize(fresh, lastSummary);
  }

  async summarize(messages, previous) {
    if (this.busy) return null;
    this.busy = true;
    try {
      const cfg = this.getConfig();
      const transcript = messages
        .map((m) => `${m.role === 'user' ? '用户' : '桌宠'}：${String(m.text).slice(0, 200)}`)
        .join('\n');

      let text = null;
      if (this.llm.isConfigured()) {
        try {
          const input =
            (previous ? `已有摘要：${previous.text}\n\n` : '') + `新增对话：\n${transcript}`;
          text = await this.llm.complete(
            [
              { role: 'system', content: PROMPT },
              { role: 'user', content: input },
            ],
            { temperature: 0.4, maxTokens: 400 }
          );
        } catch (err) {
          log.warn('模型摘要失败，改用截断摘要', err.message);
        }
      }
      if (!text) text = localSummary(messages);

      const maxChars = cfg.memory?.maxSummaryChars || 1400;
      text = String(text).trim().replace(/\s+\n/g, '\n').slice(0, maxChars);

      const rec = this.store.addSummary({
        text,
        covered: messages.length,
        fromTs: messages[0]?.ts || Date.now(),
        toTs: messages[messages.length - 1]?.ts || Date.now(),
        lastMessageId: messages[messages.length - 1]?.id || null,
      });
      this.sinceLast = 0;
      log.info(`已生成摘要（覆盖 ${messages.length} 条消息）`);
      return rec;
    } finally {
      this.busy = false;
    }
  }
}

function localSummary(messages) {
  const lines = messages
    .filter((m) => m.text)
    .slice(-14)
    .map((m) => `${m.role === 'user' ? '用户' : '桌宠'}提到：${String(m.text).slice(0, 60)}`);
  return lines.join('；').slice(0, 400);
}

module.exports = { Summarizer };
