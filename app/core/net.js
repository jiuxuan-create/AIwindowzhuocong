'use strict';
/**
 * 统一网络出口。
 *
 * 优先使用 Electron 的 `net.fetch`（Chromium 网络栈，走 Windows 系统证书库、
 * 系统代理与 PAC），只有在 Electron 不可用时才退回 Node 的全局 fetch。
 * 这样即使系统里存在 TLS 中间证书，云服务与资源下载也不会因为 Node 自带
 * CA 列表不匹配而失败。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { scoped } = require('./logger');

const log = scoped('net');

function impl() {
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      const ready = electron.app && typeof electron.app.isReady === 'function' ? electron.app.isReady() : true;
      if (ready) return electron.net.fetch;
      if (electron.app && typeof electron.app.whenReady === 'function' && !electron.__petFetchPending) {
        electron.__petFetchPending = true;
      }
    }
  } catch {
    /* 非 Electron 环境 */
  }
  return globalThis.fetch;
}

const DEFAULT_UA = 'XiaomanPet/1.0 (Windows; Electron)';

async function request(url, options = {}) {
  const fn = impl();
  if (typeof fn !== 'function') throw new Error('当前环境没有可用的 fetch 实现');
  const headers = { 'User-Agent': DEFAULT_UA, ...(options.headers || {}) };
  return fn(url, { ...options, headers });
}

async function fetchJson(url, options = {}) {
  const res = await request(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText || ''} ${url}`);
    err.status = res.status;
    err.body = text.slice(0, 800);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`响应不是合法 JSON: ${text.slice(0, 200)}`);
  }
}

async function fetchText(url, options = {}) {
  const res = await request(url, options);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url}`);
    err.status = res.status;
    err.body = text.slice(0, 400);
    throw err;
  }
  return text;
}

/**
 * 带进度回调的下载，先写 .part 再原子改名，支持断点续传时的重试。
 *
 * 除了超时，还会盯两件事：卡住不动（stallMs）和"能连上但慢得没法用"（minBps）。
 * 后者是多源下载的关键——Github 直连在国内经常是几 KB/s 地"成功"，
 * 不设速度下限的话永远轮不到镜像。
 */
async function download(
  url,
  dest,
  { onProgress, timeoutMs = 0, retries = 3, stallMs = 60000, minBps = 0, probeMs = 15000 } = {}
) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let lastErr = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let start = 0;
    try {
      start = fs.existsSync(part) ? fs.statSync(part).size : 0;
    } catch {
      start = 0;
    }
    const headers = { 'User-Agent': DEFAULT_UA };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const startedAt = Date.now();
    let receivedThisAttempt = 0;
    let lastDataAt = Date.now();
    let abortReason = '';
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (stallMs > 0 && now - lastDataAt > stallMs) {
        abortReason = `${Math.round((now - lastDataAt) / 1000)} 秒没有任何数据`;
        controller.abort();
        return;
      }
      if (minBps > 0) {
        const elapsed = (now - startedAt) / 1000;
        if (elapsed > probeMs && receivedThisAttempt / elapsed < minBps) {
          abortReason = `平均速度只有 ${(receivedThisAttempt / elapsed / 1024).toFixed(1)} KB/s`;
          controller.abort();
        }
      }
    }, 2000);

    try {
      const res = await request(url, { headers, signal: controller.signal, redirect: 'follow' });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${url}`);

      const isPartial = res.status === 206;
      const totalHeader = Number(res.headers.get('content-length') || 0);
      const total = totalHeader ? totalHeader + (isPartial ? start : 0) : 0;

      let received = isPartial ? start : 0;
      const stream = fs.createWriteStream(part, { flags: isPartial ? 'a' : 'w' });
      const reader = res.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        receivedThisAttempt += value.length;
        lastDataAt = Date.now();
        if (!stream.write(Buffer.from(value))) {
          await new Promise((r) => stream.once('drain', r));
        }
        if (onProgress) onProgress({ received, total, percent: total ? Math.min(100, (received / total) * 100) : 0 });
      }
      await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));

      if (total && received < total) throw new Error(`下载不完整 ${received}/${total}`);
      await fsp.rename(part, dest);
      return { path: dest, bytes: received };
    } catch (err) {
      lastErr = abortReason ? new Error(`${abortReason}（已中止，换源重试）`) : err;
      log.warn(`下载失败(${attempt}/${retries}) ${url}`, lastErr.message);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 900 * attempt));
    } finally {
      clearInterval(watchdog);
      if (timer) clearTimeout(timer);
    }
  }
  throw new Error(`下载失败: ${url} -> ${lastErr && lastErr.message}`);
}

/** 逐行解析 SSE 流（OpenAI 兼容接口） */
async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

module.exports = { request, fetchJson, fetchText, download, sseLines, DEFAULT_UA };
