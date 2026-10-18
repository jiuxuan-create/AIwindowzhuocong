'use strict';
/**
 * 本地管理服务（网页端控制台）。
 *
 * 只监听 127.0.0.1，除非显式开启局域网访问；所有接口都是本地读写，
 * 不向任何外部服务转发数据（模型调用只发生在用户自己配置的接口上）。
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { appDir, logDir } = require('../core/paths');
const { scoped } = require('../core/logger');

const log = scoped('console');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

class ConsoleServer {
  constructor(ctx) {
    this.ctx = ctx; // { config, store, retriever, chat, voice, emotion, llm, assets, petWindow, actions }
    this.server = null;
    this.port = 0;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/`;
  }

  async start() {
    if (this.server) return this.url;
    const cfg = this.ctx.config.all().console || {};
    const host = cfg.lanAccess ? '0.0.0.0' : '127.0.0.1';
    const preferred = cfg.port || 8799;

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error('请求处理失败', req.method, req.url, err.message);
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
      });
    });

    this.port = await listenWithFallback(this.server, host, preferred);
    log.info(`管理页已启动 ${this.url}`);
    return this.url;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }

  async handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (u.pathname.startsWith('/api/')) return this.api(req, res, u);
    return this.static(res, u.pathname);
  }

  async static(res, pathname) {
    const root = path.join(appDir(), 'renderer', 'console');
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    try {
      const stat = await fsp.stat(file);
      if (stat.isDirectory()) file = path.join(file, 'index.html');
    } catch {
      // 单页应用：未知路径回落到 index.html
      file = path.join(root, 'index.html');
    }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-length': data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  }

  // ---------------- API ----------------

  async api(req, res, u) {
    const { ctx } = this;
    const p = u.pathname.replace(/^\/api/, '');
    const q = u.searchParams;
    const method = req.method.toUpperCase();
    const seg = p.split('/').filter(Boolean);

    const ok = (data) => sendJson(res, 200, data);

    // --- 状态 ---
    if (method === 'GET' && p === '/status') {
      ctx.emotion.tick();
      return ok({
        app: { version: ctx.version, name: ctx.config.get('pet.name'), port: this.port, url: this.url },
        model: {
          configured: ctx.llm.isConfigured(),
          baseUrl: ctx.config.get('llm.baseUrl'),
          model: ctx.config.get('llm.model'),
        },
        emotion: ctx.emotion.snapshot(),
        memory: ctx.store.stats(),
        voice: { state: ctx.voice.state, enabled: ctx.config.get('voice.wake.enabled', false) },
        assets: ctx.assets.status(),
        uptimeSec: Math.round(process.uptime()),
      });
    }

    // --- 配置 ---
    if (method === 'GET' && p === '/config') return ok(ctx.config.publicConfig());
    if (method === 'POST' && p === '/config') {
      const body = await readBody(req);
      const next = ctx.config.replace(body);
      if (ctx.actions.onConfigChanged) await ctx.actions.onConfigChanged(next);
      return ok({ ok: true, config: ctx.config.publicConfig() });
    }
    if (method === 'POST' && p === '/config/reset') {
      ctx.config.reset();
      if (ctx.actions.onConfigChanged) await ctx.actions.onConfigChanged(ctx.config.all());
      return ok({ ok: true, config: ctx.config.publicConfig() });
    }
    if (method === 'POST' && p === '/config/test-llm') {
      const body = await readBody(req);
      const key = body.apiKey;
      const baseUrl = body.baseUrl;
      if (key && !String(key).includes('••')) {
        ctx.config.set('llm.apiKey', key);
      }
      if (baseUrl) ctx.config.set('llm.baseUrl', baseUrl);
      const r = await ctx.llm.test();
      return ok(r);
    }

    // --- 对话历史 ---
    if (method === 'GET' && p === '/messages') {
      return ok(
        ctx.store.searchMessages({
          q: q.get('q') || '',
          role: q.get('role') || '',
          offset: Number(q.get('offset') || 0),
          limit: Math.min(200, Number(q.get('limit') || 50)),
        })
      );
    }
    if (method === 'DELETE' && seg[0] === 'messages' && seg[1]) {
      return ok({ ok: ctx.store.deleteMessage(seg[1]) });
    }
    if (method === 'POST' && p === '/messages/clear') {
      const body = await readBody(req);
      const removed = ctx.store.clearConversation({ keepLast: Number(body.keepLast || 0) });
      return ok({ ok: true, removed });
    }

    // --- 长期记忆 ---
    if (method === 'GET' && p === '/memories') {
      return ok(
        ctx.store.listMemories({
          q: q.get('q') || '',
          kind: q.get('kind') || '',
          offset: Number(q.get('offset') || 0),
          limit: Math.min(500, Number(q.get('limit') || 200)),
          includeDeleted: q.get('deleted') === '1',
        })
      );
    }
    if (method === 'POST' && p === '/memories') {
      const body = await readBody(req);
      const rec = ctx.store.addMemory({
        text: body.text,
        kind: body.kind || 'fact',
        salience: Number(body.salience ?? 0.7),
        keywords: body.keywords || [],
        origin: 'manual',
      });
      ctx.retriever.dirty = true;
      return ok({ ok: Boolean(rec), item: rec });
    }
    if (method === 'PATCH' && seg[0] === 'memories' && seg[1]) {
      const body = await readBody(req);
      const rec = ctx.store.updateMemory(seg[1], {
        text: body.text,
        kind: body.kind,
        salience: body.salience != null ? Number(body.salience) : undefined,
      });
      ctx.retriever.dirty = true;
      return ok({ ok: Boolean(rec), item: rec });
    }
    if (method === 'DELETE' && seg[0] === 'memories' && seg[1]) {
      const purge = q.get('purge') === '1';
      const done = ctx.store.forgetMemory(seg[1], { purge });
      ctx.retriever.dirty = true;
      return ok({ ok: done, purge });
    }
    if (method === 'GET' && p === '/memories/search') {
      const query = q.get('q') || '';
      if (ctx.retriever.dirty) ctx.retriever.build(ctx.store.longterm);
      const hits = ctx.retriever.search(query, { topK: Number(q.get('topK') || 8), minScore: -1 });
      return ok({ query, hits: hits.map((h) => ctx.retriever.explain(h)) });
    }

    // --- 摘要 ---
    if (method === 'GET' && p === '/summaries') {
      return ok({ items: ctx.store.recentSummaries(50).reverse() });
    }
    if (method === 'POST' && p === '/summaries/now') {
      const r = await ctx.chat.summarizer.maybeSummarize();
      return ok({ ok: Boolean(r), item: r });
    }

    // --- 情绪 ---
    if (method === 'GET' && p === '/emotion') {
      ctx.emotion.tick();
      return ok(ctx.emotion.snapshot());
    }
    if (method === 'POST' && p === '/emotion/reset') return ok({ ok: true, state: ctx.emotion.reset() });
    if (method === 'GET' && p === '/emotion/timeline') {
      const hours = Math.min(24 * 30, Number(q.get('hours') || 72));
      const now = Date.now();
      return ok({
        from: now - hours * 3600 * 1000,
        to: now,
        samples: ctx.store.emotionTimeline({ from: now - hours * 3600 * 1000, to: now, limit: 1500 }),
      });
    }

    // --- 语音 ---
    if (method === 'GET' && p === '/voice') {
      return ok({
        state: ctx.voice.state,
        config: {
          asr: ctx.config.get('voice.asr'),
          tts: ctx.config.get('voice.tts'),
          wake: ctx.config.get('voice.wake'),
        },
        asr: ctx.assets.status().whisper,
        tts: await ctx.voice.tts.status(),
      });
    }
    if (method === 'GET' && p === '/voice/voices') {
      return ok({ voices: await ctx.voice.tts.listVoices() });
    }
    if (method === 'POST' && p === '/voice/preview') {
      const body = await readBody(req);
      const text = body.text || `你好，我是${ctx.config.get('pet.name')}。`;
      const r = await ctx.voice.speak(text);
      return ok({ ok: Boolean(r), ms: r ? r.ms : 0, backend: r ? r.backend : null, spoken: true });
    }

    // --- 运行时资源 ---
    if (method === 'GET' && p === '/runtime/assets') return ok(ctx.assets.status());
    if (method === 'GET' && p === '/runtime/progress') return ok({ jobs: ctx.assets.progress() });
    if (method === 'POST' && p === '/runtime/speech') {
      const body = await readBody(req);
      const size = body.size || ctx.config.get('voice.asr.model') || 'base';
      if (ctx.assets.running) return sendJson(res, 409, { error: '已有下载任务在进行' });
      ctx.assets
        .installSpeech(size)
        .then(() => ctx.actions.onAssetsChanged && ctx.actions.onAssetsChanged())
        .catch((e) => log.warn('语音组件下载失败', e.message));
      return ok({ ok: true, started: true, size });
    }
    if (method === 'POST' && p === '/runtime/face') {
      if (ctx.assets.running) return sendJson(res, 409, { error: '已有下载任务在进行' });
      ctx.assets
        .ensureFaceModel()
        .then(() => ctx.actions.onAssetsChanged && ctx.actions.onAssetsChanged())
        .catch((e) => log.warn('面部模型下载失败', e.message));
      return ok({ ok: true, started: true });
    }
    if (method === 'POST' && p === '/runtime/speech/remove') {
      const s = await ctx.assets.removeSpeech();
      return ok({ ok: true, assets: s });
    }

    // --- Live2D ---
    if (method === 'GET' && p === '/live2d/models') {
      const { live2dModels } = require('../core/paths');
      const models = live2dModels().map((m) => {
        let json = null;
        try {
          json = JSON.parse(fs.readFileSync(m.model3, 'utf8'));
        } catch {
          /* ignore */
        }
        const refs = (json && json.FileReferences) || {};
        return {
          id: m.id,
          dir: m.dir,
          model3: path.basename(m.model3),
          file: path.relative(appDir(), m.model3).split(path.sep).join('/'),
          textures: (refs.Textures || []).length,
          expressions: (refs.Expressions || []).map((e) => e.Name),
          motions: Object.entries(refs.Motions || {}).map(([k, v]) => ({ group: k, count: v.length })),
          current: ctx.config.get('pet.model') === m.id,
        };
      });
      return ok({ models, current: ctx.config.get('pet.model') });
    }

    // --- 桌宠动作 ---
    if (method === 'POST' && p === '/pet/say') {
      const body = await readBody(req);
      const text = String(body.text || '').slice(0, 400);
      ctx.actions.say(text, { speak: body.speak !== false, source: 'console' });
      return ok({ ok: true });
    }
    if (method === 'POST' && p === '/pet/speak') {
      const body = await readBody(req);
      const r = await ctx.voice.speak(String(body.text || '').slice(0, 400));
      return ok({ ok: Boolean(r) });
    }
    if (method === 'POST' && p === '/pet/front') {
      ctx.actions.bringToFront();
      return ok({ ok: true });
    }
    if (method === 'POST' && p === '/pet/position/reset') {
      ctx.actions.resetPosition();
      return ok({ ok: true });
    }

    // --- 调试：直接跑一轮对话 ---
    if (method === 'POST' && p === '/chat') {
      const body = await readBody(req);
      const r = await ctx.chat.send({ text: String(body.text || ''), source: 'console' });
      ctx.actions.pushTurn(r);
      return ok(r);
    }

    // --- 日志 ---
    if (method === 'GET' && p === '/logs') {
      const lines = Math.min(2000, Number(q.get('lines') || 300));
      try {
        const file = path.join(logDir(), 'pet.log');
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const all = text.split('\n').filter(Boolean);
        return ok({ lines: all.slice(-lines) });
      } catch (e) {
        return ok({ lines: [`读取日志失败：${e.message}`] });
      }
    }

    // --- 调试：把桌宠窗口或管理页当前的样子截下来 ---
    // 只允许截本机自己的页面，避免被当成任意 URL 的抓取器。
    if (method === 'POST' && p === '/debug/capture') {
      const body = await readBody(req).catch(() => ({}));
      const dir = path.join(logDir(), '..', 'captures');
      await fsp.mkdir(dir, { recursive: true });

      if (body.url) {
        const target = String(body.url);
        const allowed = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
        if (!allowed.some((a) => target.startsWith(a))) {
          return sendJson(res, 400, { error: '只允许截取本机管理页' });
        }
        const { BrowserWindow } = require('electron');
        const win = new BrowserWindow({
          width: Math.min(2000, Number(body.width) || 1240),
          height: Math.min(1600, Number(body.height) || 900),
          show: false,
          backgroundColor: '#0f1117',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        try {
          await win.loadURL(target);
          await new Promise((r) => setTimeout(r, Math.min(15000, Number(body.waitMs) || 2500)));
          const shot = await win.webContents.capturePage();
          const out = path.join(dir, `console-${Date.now()}.png`);
          await fsp.writeFile(out, shot.toPNG());
          const s = shot.getSize();
          return ok({ ok: true, file: out, width: s.width, height: s.height, url: target });
        } finally {
          win.destroy();
        }
      }

      const win = ctx.petWindow && ctx.petWindow.win;
      if (!win || win.isDestroyed()) return sendJson(res, 503, { error: '桌宠窗口不可用' });
      const image = await win.webContents.capturePage();
      const file = path.join(dir, `pet-${Date.now()}.png`);
      await fsp.writeFile(file, image.toPNG());
      const size = image.getSize();
      return ok({ ok: true, file, width: size.width, height: size.height });
    }

    // --- 调试：读桌宠运行期的尺寸/缩放快照 ---
    // 排障专用，只有数字，不含任何对话内容。
    if (method === 'POST' && p === '/debug/pet-state') {
      const win = ctx.petWindow && ctx.petWindow.win;
      if (!win || win.isDestroyed()) return sendJson(res, 503, { error: '桌宠窗口不可用' });
      const snap = await win.webContents
        .executeJavaScript('window.__petDebug ? window.__petDebug() : null')
        .catch((e) => ({ error: e.message }));
      const { screen } = require('electron');
      return ok({
        bounds: win.getBounds(),
        contentBounds: win.getContentBounds(),
        zoomFactor: win.webContents.getZoomFactor(),
        configPetScale: ctx.config.get('pet.scale'),
        configPetPosition: ctx.config.get('pet.position'),
        displays: screen.getAllDisplays().map((d) => ({
          id: d.id,
          scaleFactor: d.scaleFactor,
          bounds: d.bounds,
          workArea: d.workArea,
        })),
        snap,
      });
    }

    // --- 调试：探测某个画布坐标能不能点中桌宠 ---
    if (method === 'POST' && p === '/debug/pet-hit') {
      const win = ctx.petWindow && ctx.petWindow.win;
      if (!win || win.isDestroyed()) return sendJson(res, 503, { error: '桌宠窗口不可用' });
      const body = await readBody(req).catch(() => ({}));
      const x = Number(body.x) || 0;
      const y = Number(body.y) || 0;
      const hit = await win.webContents
        .executeJavaScript(`window.__petHit ? window.__petHit(${Math.round(x)}, ${Math.round(y)}) : null`)
        .catch((e) => ({ error: e.message }));
      return ok({ ok: true, x, y, hit });
    }

    // --- 调试：在桌宠窗口里回放一次真实的按下—拖动—松开 ---
    if (method === 'POST' && p === '/debug/pet-drag') {
      const win = ctx.petWindow && ctx.petWindow.win;
      if (!win || win.isDestroyed()) return sendJson(res, 503, { error: '桌宠窗口不可用' });
      const body = await readBody(req).catch(() => ({}));
      const from = { x: Number(body.fromX) || 0, y: Number(body.fromY) || 0 };
      const to = { x: Number(body.toX) || 0, y: Number(body.toY) || 0 };
      const steps = Math.max(1, Math.min(40, Number(body.steps) || 8));
      const holdMs = Math.max(0, Math.min(5000, Number(body.holdMs) || 400));

      const wc = win.webContents;
      wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, holdMs));
      for (let i = 1; i <= steps; i++) {
        wc.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(from.x + ((to.x - from.x) * i) / steps),
          y: Math.round(from.y + ((to.y - from.y) * i) / steps),
          button: 'left',
        });
        await new Promise((r) => setTimeout(r, 30));
      }
      wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 400));
      return ok({ ok: true, bounds: win.getBounds() });
    }

    // --- 应用控制 ---
    if (method === 'POST' && p === '/app/open-console') {
      ctx.actions.openConsole();
      return ok({ ok: true, url: this.url });
    }
    if (method === 'POST' && p === '/app/quit') {
      ok({ ok: true });
      setTimeout(() => ctx.actions.quit(), 200);
      return;
    }

    return sendJson(res, 404, { error: `未知接口 ${method} ${p}` });
  }
}

function listenWithFallback(server, host, preferred) {
  return new Promise((resolve, reject) => {
    let port = preferred;
    let attempts = 0;
    const tryListen = () => {
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    const onError = (err) => {
      server.removeListener('error', onError);
      if (err.code === 'EADDRINUSE' && attempts < 12) {
        attempts += 1;
        port = preferred + attempts;
        log.warn(`端口 ${port - 1} 被占用，尝试 ${port}`);
        tryListen();
      } else {
        reject(err);
      }
    };
    tryListen();
  });
}

module.exports = { ConsoleServer };
