'use strict';
/**
 * 大模型客户端。默认对接 DeepSeek，同时兼容任何 OpenAI 兼容 /chat/completions 服务。
 * 网络走 net.js（Electron/Chromium 栈），带超时、中止与流式输出。
 */
const { request, sseLines } = require('./net');
const { scoped } = require('./logger');

const log = scoped('llm');

function friendlyError(status, body, baseUrl) {
  const b = (body || '').toLowerCase();
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请在管理页检查 Key';
  if (status === 402) return '账户余额不足，请先充值';
  if (status === 429) return '请求过于频繁或额度已用尽，稍后再试';
  if (status === 404) return `接口地址不正确（${baseUrl}），请确认 Base URL 是否需要带 /v1`;
  if (status >= 500) return '模型服务暂时不可用，稍后再试';
  if (b.includes('model')) return '模型名不被支持，请在管理页换一个模型';
  return `模型服务返回 ${status}`;
}

function normalizeBase(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) base = 'https://api.deepseek.com';
  return base;
}

class LLMClient {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  opts() {
    const c = this.getConfig().llm || {};
    const base = normalizeBase(c.baseUrl);
    return {
      base,
      // DeepSeek 官方同时支持 /chat/completions 与 /v1/chat/completions
      url: /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`,
      modelsUrl: /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`,
      apiKey: c.apiKey || '',
      model: c.model || 'deepseek-chat',
      temperature: typeof c.temperature === 'number' ? c.temperature : 1.2,
      maxTokens: c.maxTokens || 700,
      stream: c.stream !== false,
      timeoutMs: c.timeoutMs || 60000,
    };
  }

  isConfigured() {
    const { apiKey, base } = this.opts();
    return Boolean(apiKey && base);
  }

  async _fetch(url, body, { signal, timeoutMs } = {}) {
    const o = this.opts();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs || o.timeoutMs);
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: body && body.stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${o.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const msg = friendlyError(res.status, text, o.base);
        const err = new Error(msg);
        err.status = res.status;
        err.raw = text.slice(0, 600);
        throw err;
      }
      return res;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 流式对话。onDelta 收到增量文本。
   * 返回完整文本。
   */
  async streamChat(messages, { onDelta, signal, temperature, maxTokens, json } = {}) {
    const o = this.opts();
    const body = {
      model: o.model,
      messages,
      stream: true,
      temperature: temperature ?? o.temperature,
      max_tokens: maxTokens ?? o.maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };

    const res = await this._fetch(o.url, body, { signal });
    let full = '';
    let finish = null;
    for await (const line of sseLines(res)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message || '模型返回错误');
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      const piece = delta.content || (delta.reasoning_content ? '' : '');
      if (piece) {
        full += piece;
        if (onDelta) onDelta(piece, full);
      }
    }
    return { text: full, finish };
  }

  /** 非流式对话，返回纯文本 */
  async complete(messages, { signal, temperature, maxTokens, json } = {}) {
    const o = this.opts();
    const body = {
      model: o.model,
      messages,
      stream: false,
      temperature: temperature ?? o.temperature,
      max_tokens: maxTokens ?? o.maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };
    const res = await this._fetch(o.url, body, { signal });
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error('模型没有返回内容');
    return (choice.message && choice.message.content) || '';
  }

  /** 连接自检：优先 /models，失败再退回一次极小对话 */
  async test() {
    const o = this.opts();
    if (!o.apiKey) return { ok: false, message: '尚未填写 API Key' };
    try {
      const res = await request(o.modelsUrl, {
        headers: { Authorization: `Bearer ${o.apiKey}`, Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const ids = (data.data || []).map((m) => m.id).filter(Boolean);
        return {
          ok: true,
          message: `连接正常${ids.length ? `，可用模型 ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ' …' : ''}` : ''}`,
          models: ids,
        };
      }
      const text = await res.text().catch(() => '');
      if (res.status === 404) {
        // 有些兼容服务没有 /models，用一次最小对话验证
        const t = await this.complete([{ role: 'user', content: 'ping' }], { maxTokens: 4 });
        return { ok: true, message: `连接正常（探针回复：${String(t).slice(0, 20) || '空'}）` };
      }
      return { ok: false, message: friendlyError(res.status, text, o.base) };
    } catch (err) {
      if (err.status) return { ok: false, message: err.message };
      return { ok: false, message: `无法连接：${err.message}` };
    }
  }
}

module.exports = { LLMClient, normalizeBase, friendlyError };
