'use strict';
/**
 * 记忆存储层。
 *
 * 用 JSONL 追加日志 + 内存索引，避免原生 SQLite 依赖（Electron 下免编译、免 ABI 适配）。
 * 三类记录分开存放：
 *   conversation.jsonl  逐条对话（含当轮情绪快照）
 *   longterm.jsonl      长期记忆条目（可遗忘、可编辑）
 *   summaries.jsonl     滚动摘要
 * 写入使用「追加 + 定时压缩」，单文件超过阈值时做一次去重合并。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { memoryDir } = require('../paths');
const { scoped } = require('../logger');

const log = scoped('memory');
const COMPACT_BYTES = 4 * 1024 * 1024;

function nid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

class JsonlFile {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
    this.size = 0;
    try {
      this.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch {
      this.size = 0;
    }
  }

  append(record) {
    const line = JSON.stringify(record) + '\n';
    this.size += Buffer.byteLength(line);
    this.queue = this.queue
      .then(() => fsp.appendFile(this.file, line, 'utf8'))
      .catch((err) => log.error('写入失败', this.file, err.message));
    return this.queue;
  }

  async rewrite(records) {
    const tmp = this.file + '.tmp';
    const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    await this.queue;
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, this.file);
    this.size = Buffer.byteLength(body);
  }

  readAll() {
    try {
      if (!fs.existsSync(this.file)) return [];
      const text = fs.readFileSync(this.file, 'utf8');
      const out = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t));
        } catch {
          /* 跳过损坏行 */
        }
      }
      return out;
    } catch (err) {
      log.error('读取失败', this.file, err.message);
      return [];
    }
  }

  get needsCompact() {
    return this.size > COMPACT_BYTES;
  }
}

class MemoryStore extends EventEmitter {
  constructor(getConfig) {
    super();
    this.getConfig = getConfig;
    const dir = memoryDir();
    this.files = {
      conversation: new JsonlFile(path.join(dir, 'conversation.jsonl')),
      longterm: new JsonlFile(path.join(dir, 'longterm.jsonl')),
      summaries: new JsonlFile(path.join(dir, 'summaries.jsonl')),
      emotion: new JsonlFile(path.join(dir, 'emotion.jsonl')),
    };
    this.load();
    this._compactTimer = setInterval(() => this.compactAll().catch(() => {}), 10 * 60 * 1000);
    if (this._compactTimer.unref) this._compactTimer.unref();
  }

  load() {
    this.messages = this.files.conversation.readAll();
    this.longterm = this.files.longterm.readAll().filter((m) => !m.deleted);
    this.summaries = this.files.summaries.readAll();
    this.emotions = this.files.emotion.readAll();
    this.index = this._buildIndex();
    log.info(
      `记忆载入：对话 ${this.messages.length} 条 / 长期 ${this.longterm.length} 条 / 摘要 ${this.summaries.length} 条`
    );
  }

  _buildIndex() {
    const byId = new Map();
    for (const m of this.longterm) byId.set(m.id, m);
    this._byId = byId;
    return { byId };
  }

  // ---------- 对话 ----------

  addMessage(msg) {
    const rec = {
      id: msg.id || nid('msg'),
      ts: msg.ts || Date.now(),
      role: msg.role, // 'user' | 'pet' | 'system'
      text: String(msg.text || ''),
      source: msg.source || 'text', // text | voice | console | system | wake
      emotion: msg.emotion || null,
      meta: msg.meta || {},
    };
    this.messages.push(rec);
    this.files.conversation.append(rec);
    this.emit('message', rec);
    return rec;
  }

  recentMessages(limit = 20) {
    return this.messages.slice(-limit);
  }

  /** 最近若干轮（user+pet 记为一轮） */
  recentTurns(turns = 12) {
    return this.messages.slice(-Math.max(2, turns * 2));
  }

  searchMessages({ q = '', limit = 100, offset = 0, role = '' } = {}) {
    let list = this.messages;
    if (role) list = list.filter((m) => m.role === role);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((m) => String(m.text).toLowerCase().includes(needle));
    }
    const total = list.length;
    const items = list.slice(Math.max(0, total - offset - limit), Math.max(0, total - offset));
    return { total, items };
  }

  deleteMessage(id) {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    this.messages.splice(idx, 1);
    this._scheduleRewrite('conversation', this.messages);
    return true;
  }

  clearConversation({ keepLast = 0 } = {}) {
    const removed = this.messages.length - keepLast;
    this.messages = keepLast > 0 ? this.messages.slice(-keepLast) : [];
    this._scheduleRewrite('conversation', this.messages);
    return removed;
  }

  // ---------- 长期记忆 ----------

  addMemory(item) {
    const rec = {
      id: item.id || nid('mem'),
      ts: item.ts || Date.now(),
      kind: item.kind || 'fact', // fact | preference | event | relation | summary
      text: String(item.text || '').trim(),
      keywords: item.keywords || [],
      salience: typeof item.salience === 'number' ? item.salience : 0.55,
      sourceMessageIds: item.sourceMessageIds || [],
      recallCount: 0,
      lastRecallTs: null,
      weight: 1,
      origin: item.origin || 'chat',
    };
    if (!rec.text) return null;
    // 近似去重：同义重复只保留信息量更大的一条
    const dup = this.longterm.find(
      (m) => m.text === rec.text || (m.text.length > 6 && rec.text.includes(m.text) && m.text.length / rec.text.length > 0.75)
    );
    if (dup) {
      if (rec.text.length > dup.text.length) dup.text = rec.text;
      dup.salience = Math.min(1, dup.salience + 0.05);
      dup.updatedAt = Date.now();
      this.files.longterm.append({ ...dup, _update: true });
      this.emit('memory:update', dup);
      return dup;
    }
    this.longterm.push(rec);
    this._byId.set(rec.id, rec);
    this.files.longterm.append(rec);
    this.emit('memory:add', rec);
    return rec;
  }

  updateMemory(id, patch) {
    const rec = this._byId.get(id);
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    this.files.longterm.append({ ...rec, _update: true });
    this.emit('memory:update', rec);
    return rec;
  }

  /** 遗忘：默认软删除（保留可审计痕迹），purge=true 时彻底移除 */
  forgetMemory(id, { purge = false } = {}) {
    const rec = this._byId.get(id);
    if (!rec) return false;
    if (purge) {
      this.longterm = this.longterm.filter((m) => m.id !== id);
      this._byId.delete(id);
      this._scheduleRewrite('longterm', this.longterm);
    } else {
      rec.deleted = true;
      rec.deletedTs = Date.now();
      this.longterm = this.longterm.filter((m) => m.id !== id);
      this._byId.delete(id);
      this.files.longterm.append({ id, deleted: true, deletedTs: rec.deletedTs });
    }
    this.emit('memory:forget', rec);
    return true;
  }

  noteRecall(ids) {
    const now = Date.now();
    for (const id of ids) {
      const rec = this._byId.get(id);
      if (!rec) continue;
      rec.recallCount = (rec.recallCount || 0) + 1;
      rec.lastRecallTs = now;
    }
    this._scheduleRewrite('longterm', this.longterm);
  }

  listMemories({ q = '', kind = '', limit = 200, offset = 0, includeDeleted = false } = {}) {
    let list = includeDeleted ? this.files.longterm.readAll() : this.longterm;
    if (kind) list = list.filter((m) => m.kind === kind);
    if (q) {
      const n = q.toLowerCase();
      list = list.filter(
        (m) => String(m.text).toLowerCase().includes(n) || (m.keywords || []).some((k) => String(k).toLowerCase().includes(n))
      );
    }
    list = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return { total: list.length, items: list.slice(offset, offset + limit) };
  }

  // ---------- 摘要 ----------

  addSummary(s) {
    const rec = {
      id: s.id || nid('sum'),
      ts: s.ts || Date.now(),
      fromTs: s.fromTs || null,
      toTs: s.toTs || null,
      covered: s.covered || 0,
      text: String(s.text || '').trim(),
      lastMessageId: s.lastMessageId || null,
    };
    if (!rec.text) return null;
    this.summaries.push(rec);
    this.files.summaries.append(rec);
    this.emit('summary:add', rec);
    return rec;
  }

  latestSummary() {
    return this.summaries.length ? this.summaries[this.summaries.length - 1] : null;
  }

  recentSummaries(n = 3) {
    return this.summaries.slice(-n);
  }

  // ---------- 情绪时间线 ----------

  addEmotionSample(sample) {
    const rec = { ts: sample.ts || Date.now(), ...sample };
    this.emotions.push(rec);
    this.files.emotion.append(rec);
    if (this.emotions.length > 5000) {
      this.emotions = this.emotions.slice(-3000);
      this._scheduleRewrite('emotion', this.emotions);
    }
    return rec;
  }

  emotionTimeline({ from = 0, to = Date.now(), limit = 1000 } = {}) {
    let list = this.emotions.filter((e) => e.ts >= from && e.ts <= to);
    if (list.length > limit) {
      const step = Math.ceil(list.length / limit);
      list = list.filter((_, i) => i % step === 0);
    }
    return list;
  }

  // ---------- 维护 ----------

  _scheduleRewrite(kind, records) {
    clearTimeout(this._rewriteTimers?.[kind]);
    this._rewriteTimers = this._rewriteTimers || {};
    this._rewriteTimers[kind] = setTimeout(() => {
      this.files[kind].rewrite(records).catch((e) => log.warn('重写失败', kind, e.message));
    }, 1500);
  }

  async compactAll() {
    try {
      if (this.files.conversation.needsCompact) {
        await this.files.conversation.rewrite(this.messages);
      }
      if (this.files.longterm.needsCompact) {
        await this.files.longterm.rewrite(this.longterm);
      }
      if (this.files.summaries.needsCompact) {
        await this.files.summaries.rewrite(this.summaries);
      }
    } catch (err) {
      log.warn('压缩失败', err.message);
    }
  }

  stats() {
    return {
      messages: this.messages.length,
      memories: this.longterm.length,
      summaries: this.summaries.length,
      emotionSamples: this.emotions.length,
      firstMessageTs: this.messages.length ? this.messages[0].ts : null,
      lastMessageTs: this.messages.length ? this.messages[this.messages.length - 1].ts : null,
      bytes: Object.values(this.files).reduce((s, f) => s + f.size, 0),
    };
  }

  dispose() {
    clearInterval(this._compactTimer);
    for (const t of Object.values(this._rewriteTimers || {})) clearTimeout(t);
  }
}

module.exports = { MemoryStore, nid };
