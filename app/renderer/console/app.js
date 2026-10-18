/**
 * 管理台前端。
 *
 * 设计原则：所有配置项都由 FIELDS 这张表驱动渲染，加一个配置只需要加一行，
 * 不用同时改 HTML 和 JS。密钥字段有「留空即不改」语义，不允许被打码值覆盖。
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ 小工具

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') el.setAttribute('style', v);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    const kids = children == null ? [] : Array.isArray(children) ? children : [children];
    for (const c of kids) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  async function api(path, opts) {
    const res = await fetch('/api' + path, {
      headers: { 'content-type': 'application/json' },
      ...opts,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
    return data;
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), isErr ? 5200 : 2600);
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtFull(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
  }

  function relTime(ts) {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    return Math.floor(d / 86400e3) + ' 天前';
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟';
    const hh = Math.floor(m / 60);
    return `${hh} 小时 ${m % 60} 分钟`;
  }

  function get(pathStr) {
    return String(pathStr)
      .split('.')
      .reduce((a, p) => (a == null ? undefined : a[p]), S.draft);
  }

  function set(pathStr, value) {
    const parts = String(pathStr).split('.');
    const last = parts.pop();
    let cur = S.draft;
    for (const p of parts) {
      if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[last] = value;
  }

  // 读取已生效的配置，任何一层缺失都返回兜底值，避免整个页面画不出来
  function cfg(pathStr, dflt) {
    let cur = S.cfg;
    for (const p of String(pathStr).split('.')) {
      if (cur == null || typeof cur !== 'object') return dflt;
      cur = cur[p];
    }
    return cur == null ? dflt : cur;
  }

  // ------------------------------------------------------------ 配置表

  const SECRET_PATHS = ['llm.apiKey', 'voice.tts.apiKey'];

  const FIELDS = {
    pet: [
      { p: 'pet.name', label: '名字', t: 'text', hint: '它自称、以及被叫醒时用的名字' },
      { p: 'pet.aliases', label: '别名', t: 'list', hint: '逗号分隔，叫这些名字它也会应' },
      { p: 'pet.scale', label: '窗口缩放', t: 'range', min: 0.35, max: 2.5, step: 0.05 },
      { p: 'pet.opacity', label: '不透明度', t: 'range', min: 0.2, max: 1, step: 0.05 },
      { p: 'pet.bubbleTimeoutMs', label: '气泡停留', t: 'number', min: 2000, max: 60000, step: 1000, unit: '毫秒' },
      { p: 'pet.bubbleMaxChars', label: '气泡最多字数', t: 'number', min: 40, max: 600, step: 10 },
      { p: 'pet.bubbleAreaHeight', label: '顶部气泡区高度', t: 'number', min: 0, max: 320, step: 4, unit: '像素', hint: '角色会站在这条带子下面，气泡弹出来就不会糊脸' },
      { p: 'pet.fit', label: '模型适配', t: 'select', opts: [['height', '按高度铺满'], ['contain', '完整显示（可能留边）'], ['cover', '铺满并裁切']] },
      { p: 'pet.zoom', label: '缩放微调', t: 'range', min: 0.5, max: 2, step: 0.01 },
      { p: 'pet.offsetX', label: '水平偏移', t: 'number', min: -400, max: 400, step: 1, unit: '像素' },
      { p: 'pet.offsetY', label: '垂直偏移', t: 'number', min: -400, max: 400, step: 1, unit: '像素' },
      { p: 'pet.model', label: 'Live2D 模型', t: 'select', opts: '@models' },
      { p: 'pet.alwaysOnTop', label: '总在最前', t: 'bool' },
      { p: 'pet.clickThrough', label: '点击穿透', t: 'bool', hint: '打开后鼠标完全穿过桌宠，只能用托盘操作它' },
      { p: 'pet.silentMode', label: '静音模式', t: 'bool', hint: '不主动搭话、不出声' },
      { p: 'pet.idleWander', label: '空闲时轻微晃动', t: 'bool' },
      { p: 'pet.lookAtMouse', label: '视线跟随鼠标', t: 'bool' },
    ],
    persona: [
      { p: 'persona.prompt', label: '人格提示词', t: 'textarea', hint: '它怎么说话、有什么性格，全靠这一段' },
      { p: 'persona.userNickname', label: '怎么称呼你', t: 'text' },
      { p: 'persona.selfAwareness', label: '知道自己住在电脑里', t: 'bool' },
    ],
    llm: [
      { p: 'llm.provider', label: '服务商备注', t: 'text', hint: '只用来给你自己看，不影响调用' },
      { p: 'llm.baseUrl', label: '接口地址', t: 'text', hint: 'DeepSeek 填 https://api.deepseek.com；Ollama 填 http://127.0.0.1:11434' },
      { p: 'llm.model', label: '模型名', t: 'text', hint: 'DeepSeek 用 deepseek-chat' },
      { p: 'llm.apiKey', label: 'API Key', t: 'password', secret: true, hint: '留空表示保持原值；只存在本机，不会上传到别处' },
      { p: 'llm.temperature', label: '温度', t: 'range', min: 0, max: 2, step: 0.05 },
      { p: 'llm.maxTokens', label: '最长回复', t: 'number', min: 64, max: 4096, step: 16, unit: 'token' },
      { p: 'llm.stream', label: '流式输出', t: 'bool' },
      { p: 'llm.timeoutMs', label: '超时', t: 'number', min: 5000, max: 180000, step: 1000, unit: '毫秒' },
      { p: 'llm.fallback', label: '调用失败时用内置规则兜底', t: 'bool', hint: '关掉的话，失败就直接报错' },
    ],
    memory: [
      { p: 'memory.enabled', label: '启用记忆', t: 'bool' },
      { p: 'memory.longTermEnabled', label: '启用长期记忆', t: 'bool', hint: '关掉后只保留最近几轮对话' },
      { p: 'memory.recentTurns', label: '上下文保留轮数', t: 'number', min: 2, max: 40, step: 1, unit: '轮' },
      { p: 'memory.retrievalTopK', label: '每轮召回条数', t: 'number', min: 0, max: 20, step: 1, unit: '条' },
      { p: 'memory.minScore', label: '召回最低分', t: 'range', min: 0, max: 1, step: 0.01, hint: '调高更挑，调低更容易想起来' },
      { p: 'memory.summarizeEveryTurns', label: '多少轮总结一次', t: 'number', min: 2, max: 60, step: 1, unit: '轮' },
      { p: 'memory.maxSummaryChars', label: '摘要最长字数', t: 'number', min: 200, max: 4000, step: 50 },
      { p: 'memory.emotionDecayHalfLifeHours', label: '情绪半衰期', t: 'number', min: 1, max: 168, step: 1, unit: '小时' },
      { p: 'memory.freezeEmotionPerMessage', label: '冻结每条消息的当轮情绪', t: 'bool', hint: '让历史记录保留当时的情绪，而不是被后来的状态覆盖' },
    ],
    emotion: [
      { p: 'emotion.textEnabled', label: '从文字读情绪', t: 'bool' },
      { p: 'emotion.audioEnabled', label: '从声音读情绪', t: 'bool', hint: '本地算音量、音高、语速、停顿，音频不出这台电脑' },
      { p: 'emotion.videoEnabled', label: '从摄像头读表情', t: 'bool', hint: '本地推理，画面不出这台电脑、不落盘' },
      { p: 'emotion.videoSampleMs', label: '表情采样间隔', t: 'number', min: 1000, max: 20000, step: 500, unit: '毫秒' },
      { p: 'emotion.weights.text', label: '文字权重', t: 'range', min: 0, max: 1, step: 0.05 },
      { p: 'emotion.weights.audio', label: '声音权重', t: 'range', min: 0, max: 1, step: 0.05 },
      { p: 'emotion.weights.video', label: '表情权重', t: 'range', min: 0, max: 1, step: 0.05 },
      { p: 'emotion.moodInertia', label: '情绪惯性', t: 'range', min: 0, max: 0.98, step: 0.02, hint: '越大，它的心情变得越慢' },
      { p: 'emotion.affinityGainPerTurn', label: '每轮亲密度增长', t: 'range', min: 0, max: 2, step: 0.05 },
    ],
    console: [
      { p: 'console.port', label: '管理页端口', t: 'number', min: 1024, max: 65535, step: 1, hint: '改完需要重启应用才生效' },
      { p: 'console.lanAccess', label: '允许局域网访问', t: 'bool', hint: '打开后同网段设备也能打开这个页面，注意隐私' },
      { p: 'console.openOnStart', label: '启动时自动打开管理页', t: 'bool' },
    ],
  };

  const NAV = [
    ['overview', '概览'],
    ['chat', '对话'],
    ['memory', '记忆'],
    ['emotion', '情绪'],
    ['voice', '语音'],
    ['pet', '桌宠'],
    ['llm', '模型与人格'],
    ['logs', '日志'],
  ];

  // ------------------------------------------------------------ 状态

  const S = {
    cfg: null,
    draft: null,
    status: null,
    models: [],
    voices: [],
    route: 'overview',
    dirty: false,
    polling: null,
  };

  // ------------------------------------------------------------ 表单渲染

  function optionList(spec) {
    if (spec.opts === '@models') {
      return S.models.length
        ? S.models.map((m) => [m.id, `${m.id}（表情 ${m.expressions.length} / 动作 ${m.motions.map((x) => x.group).join('、')}）`])
        : [['Haru', 'Haru']];
    }
    return spec.opts || [];
  }

  function renderField(spec) {
    const ctl = h('div', { class: 'ctl' });
    const val = get(spec.p);

    if (spec.t === 'bool') {
      const box = h('input', { type: 'checkbox' });
      box.checked = Boolean(val);
      const word = h('span', { text: box.checked ? '已开启' : '已关闭' });
      box.addEventListener('change', () => {
        set(spec.p, box.checked);
        word.textContent = box.checked ? '已开启' : '已关闭';
        markDirty();
      });
      ctl.appendChild(h('label', { class: 'switch' }, [box, word]));
    } else if (spec.t === 'select') {
      const sel = h('select');
      for (const [v, label] of optionList(spec)) {
        const o = h('option', { value: v }, label);
        if (String(val) === String(v)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        set(spec.p, sel.value);
        markDirty();
      });
      ctl.appendChild(sel);
    } else if (spec.t === 'range') {
      const num = h('input', { type: 'number', class: 'num', min: spec.min, max: spec.max, step: spec.step });
      const rng = h('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step });
      const v0 = val == null ? spec.min : val;
      num.value = v0;
      rng.value = v0;
      rng.addEventListener('input', () => {
        num.value = rng.value;
        set(spec.p, Number(rng.value));
        markDirty();
      });
      num.addEventListener('change', () => {
        rng.value = num.value;
        set(spec.p, Number(num.value));
        markDirty();
      });
      ctl.appendChild(h('div', { class: 'inline-num' }, [rng, num]));
    } else if (spec.t === 'number') {
      const num = h('input', { type: 'number', min: spec.min, max: spec.max, step: spec.step });
      num.value = val == null ? '' : val;
      num.addEventListener('change', () => {
        set(spec.p, num.value === '' ? 0 : Number(num.value));
        markDirty();
      });
      ctl.appendChild(num);
    } else if (spec.t === 'textarea') {
      const ta = h('textarea');
      ta.value = val == null ? '' : String(val);
      ta.addEventListener('input', () => {
        set(spec.p, ta.value);
        markDirty();
      });
      ctl.appendChild(ta);
    } else if (spec.t === 'list') {
      const inp = h('input', { type: 'text' });
      inp.value = Array.isArray(val) ? val.join('、') : val == null ? '' : String(val);
      inp.addEventListener('change', () => {
        set(
          spec.p,
          inp.value
            .split(/[,，、\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        );
        markDirty();
      });
      ctl.appendChild(inp);
    } else if (spec.t === 'password') {
      const inp = h('input', { type: 'password', placeholder: val ? `已保存（${val}）——留空不改` : '还没有填' });
      inp.addEventListener('input', () => {
        set(spec.p, inp.value);
        markDirty();
      });
      ctl.appendChild(inp);
    } else {
      const inp = h('input', { type: 'text' });
      inp.value = val == null ? '' : String(val);
      inp.addEventListener('change', () => {
        set(spec.p, inp.value);
        markDirty();
      });
      ctl.appendChild(inp);
    }

    const hintText = [spec.hint, spec.unit ? `单位：${spec.unit}` : ''].filter(Boolean).join(' · ');
    if (hintText) ctl.appendChild(h('div', { class: 'hint', text: hintText }));
    return h('div', { class: 'field' }, [h('label', { text: spec.label }), ctl]);
  }

  function sectionForm(name) {
    const specs = FIELDS[name] || [];
    return h(
      'div',
      { class: 'card' },
      specs.map(renderField)
    );
  }

  function markDirty() {
    S.dirty = true;
    const bar = document.getElementById('savebar');
    if (bar) bar.hidden = false;
  }

  function buildPayload() {
    const payload = JSON.parse(JSON.stringify(S.draft));
    for (const p of SECRET_PATHS) {
      const incoming = get(p);
      const original = String(p).split('.').reduce((a, k) => (a == null ? undefined : a[k]), S.cfg);
      if (incoming === original) {
        // 用户没动过这个密钥：回传空串，主进程会保留原值
        const parts = p.split('.');
        let cur = payload;
        for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
        cur[parts[parts.length - 1]] = '';
      }
    }
    return payload;
  }

  async function saveConfig() {
    try {
      const r = await api('/config', { method: 'POST', body: buildPayload() });
      S.cfg = r.config;
      S.draft = JSON.parse(JSON.stringify(r.config));
      S.dirty = false;
      document.getElementById('savebar').hidden = true;
      toast('已保存');
      render();
      refreshStatus();
    } catch (e) {
      toast('保存失败：' + e.message, true);
    }
  }

  function saveBar() {
    const bar = h('div', { class: 'card', id: 'savebar', style: 'display:flex;gap:10px;align-items:center' });
    bar.hidden = !S.dirty;
    bar.appendChild(h('span', { class: 'hint', text: '有未保存的改动', style: 'flex:1' }));
    const reset = h('button', { class: 'btn ghost', text: '撤销改动', onclick: () => location.reload() });
    const save = h('button', { class: 'btn', text: '保存', onclick: saveConfig });
    bar.appendChild(reset);
    bar.appendChild(save);
    return bar;
  }

  // ------------------------------------------------------------ 视图

  function statCard(k, v, extra, small) {
    return h('div', { class: 'stat' }, [
      h('div', { class: 'k', text: k }),
      h('div', { class: 'v' + (small ? ' sm' : ''), text: String(v) }),
      extra ? h('div', { class: 'x', text: extra }) : null,
    ]);
  }

  function asyncBox(loader, render) {
    const box = h('div', {}, [h('div', { class: 'empty', text: '读取中…' })]);
    loader()
      .then((data) => {
        box.innerHTML = '';
        const out = render(data);
        box.appendChild(out);
      })
      .catch((e) => {
        box.innerHTML = '';
        box.appendChild(h('div', { class: 'empty', text: '读取失败：' + e.message }));
      });
    return box;
  }

  // ---- 概览 ----
  function viewOverview() {
    const st = S.status || {};
    const em = st.emotion || {};
    const mem = st.memory || {};
    const assets = st.assets || {};

    return h('section', {}, [
      h('h1', { text: '概览' }),
      h('p', { class: 'sub', text: '桌宠的运行状态、模型连通性、记忆规模都在这里。' }),

      h('div', { class: 'grid c4' }, [
        statCard('对话模型', (st.model && st.model.configured) ? '已连接' : '本地模式', st.model ? st.model.model : '', true),
        statCard('对话条数', mem.messages || 0, mem.lastMessageTs ? '最近 ' + relTime(mem.lastMessageTs) : '还没聊过'),
        statCard('长期记忆', mem.memories || 0, `摘要 ${mem.summaries || 0} 条`),
        statCard('亲密度', ((em.affinity || 0) * 100).toFixed(0) + '%', `精力 ${((em.energy || 0) * 100).toFixed(0)}%`),
      ]),

      h('h2', { text: '现在的它' }),
      h('div', { class: 'card' }, [
        h('dl', { class: 'kv' }, [
          h('dt', { text: '名字' }), h('dd', { text: cfg('pet.name', '—') }),
          h('dt', { text: '心情' }), h('dd', { text: `${em.moodLabelZh || em.moodLabel || '—'}（效价 ${(em.mood ? em.mood.valence.toFixed(2) : '—')} / 唤醒 ${(em.mood ? em.mood.arousal.toFixed(2) : '—')}）` }),
          h('dt', { text: '你的情绪' }), h('dd', { text: `${em.userMoodLabelZh || em.userMoodLabel || '—'}（${em.userMood ? em.userMood.valence.toFixed(2) : '—'}）` }),
          h('dt', { text: '互动次数' }), h('dd', { text: String(em.interactions || 0) }),
          h('dt', { text: '运行时长' }), h('dd', { text: fmtDuration(st.uptimeSec || 0) }),
          h('dt', { text: '组件目录' }), h('dd', { class: 'mono', text: assets.modelDir || '—' }),
        ]),
      ]),

      h('h2', { text: '快捷操作' }),
      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [
          h('button', { class: 'btn', text: '把桌宠叫到前面', onclick: () => api('/pet/front', { method: 'POST' }).then(() => toast('已置前')) }),
          h('button', { class: 'btn ghost', text: '让它说一句', onclick: promptSay }),
          h('button', {
            class: 'btn ghost',
            text: '回到屏幕右下角',
            onclick: () => api('/pet/position/reset', { method: 'POST' }).then(() => toast('位置已重置')),
          }),
          h('button', {
            class: 'btn danger',
            text: '退出桌宠',
            onclick: () => {
              if (confirm('确定要退出桌宠吗？')) api('/app/quit', { method: 'POST' }).catch(() => {});
            },
          }),
        ]),
      ]),

      h('h2', { text: '本地语音组件' }),
      h('div', { class: 'card' }, [
        h('p', { class: 'hint', text: '语音识别完全在本机跑，需要先下载 whisper.cpp 运行文件和语音模型。视频通话式的云端识别不会被使用。' }),
        h('dl', { class: 'kv' }, [
          h('dt', { text: '识别引擎' }),
          h('dd', {}, [
            h('span', {
              class: 'tag ' + (assets.whisper && assets.whisper.binaryReady ? 'ok' : 'warn'),
              text: assets.whisper && assets.whisper.binaryReady ? '已就绪' : '未安装',
            }),
          ]),
          h('dt', { text: '语音模型' }),
          h('dd', {}, [
            assets.whisper && assets.whisper.models
              ? h(
                  'div',
                  { class: 'tips' },
                  assets.whisper.models.map((m) =>
                    h('span', { class: 'tag ' + (m.ready ? 'ok' : '') , title: m.note || '' }, [
                      `${m.id} ${m.mb}MB${m.ready ? ' ✓ 已下载' : ''}`,
                    ])
                  )
                )
              : h('span', { text: '—' }),
          ]),
          h('dt', { text: '表情模型' }),
          h('dd', {}, [
            h('span', { class: 'tag ' + (assets.face && assets.face.ready ? 'ok' : ''), text: assets.face && assets.face.ready ? '已就绪' : '未下载' }),
          ]),
        ]),
        h('div', { class: 'row', style: 'margin-top:10px' }, [
          h('button', { class: 'btn', text: '去下载语音组件', onclick: () => go('voice') }),
        ]),
      ]),
    ]);
  }

  function promptSay() {
    const t = prompt('让它说什么？', '我来啦。');
    if (t == null) return;
    api('/pet/say', { method: 'POST', body: { text: t, speak: true } })
      .then(() => toast('已发送'))
      .catch((e) => toast(e.message, true));
  }

  // ---- 对话 ----
  function viewChat() {
    const box = h('div', {});
    const q = h('input', { type: 'text', placeholder: '搜索说过的话…' });
    const role = h('select');
    for (const [v, t] of [['', '全部'], ['user', '我说'], ['pet', '它说']]) role.appendChild(h('option', { value: v }, t));

    const listBox = h('div', { class: 'list' });

    async function load() {
      listBox.innerHTML = '';
      listBox.appendChild(h('div', { class: 'empty', text: '读取中…' }));
      try {
        const r = await api(`/messages?q=${encodeURIComponent(q.value)}&role=${role.value}&limit=120`);
        listBox.innerHTML = '';
        if (!r.items.length) {
          listBox.appendChild(h('div', { class: 'empty', text: '这里还是空的。' }));
          return;
        }
        for (const m of r.items.slice().reverse()) {
          const cls = m.role === 'user' ? 'user' : m.role === 'pet' ? 'pet' : 'sys';
          const meta = h('div', { class: 'meta' }, [
            h('span', { text: fmtFull(m.ts) }),
            h('span', { class: 'tag', text: m.role === 'user' ? '我' : m.role === 'pet' ? '小满' : '系统' }),
            m.source ? h('span', { class: 'tag', text: m.source }) : null,
            m.emotion && m.emotion.label ? h('span', { class: 'tag', text: m.emotion.label }) : null,
          ]);
          const del = h('button', {
            class: 'btn ghost sm',
            text: '删除',
            onclick: async () => {
              await api('/messages/' + m.id, { method: 'DELETE' });
              load();
              toast('已删除');
            },
          });
          listBox.appendChild(
            h('div', { class: 'item ' + cls }, [meta, h('div', { class: 'body', text: m.text }), h('div', { class: 'acts' }, [del])])
          );
        }
      } catch (e) {
        listBox.innerHTML = '';
        listBox.appendChild(h('div', { class: 'empty', text: '读取失败：' + e.message }));
      }
    }

    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    });
    role.addEventListener('change', load);

    const clear = h('button', {
      class: 'btn danger sm',
      text: '清空全部对话',
      onclick: async () => {
        if (!confirm('清空后对话记录不可恢复（长期记忆不受影响），确定吗？')) return;
        await api('/messages/clear', { method: 'POST', body: { keepLast: 0 } });
        load();
        toast('已清空');
      },
    });

    box.appendChild(
      h('div', { class: 'row', style: 'margin-bottom:12px' }, [h('div', { style: 'flex:1' }, q), role, clear])
    );
    box.appendChild(listBox);
    setTimeout(load, 0);
    return h('section', {}, [
      h('h1', { text: '对话' }),
      h('p', { class: 'sub', text: '你和它说过的每一句都在这里，可以按角色筛选、搜索，也可以单独删掉某一条。' }),
      box,
    ]);
  }

  // ---- 记忆 ----
  function viewMemory() {
    const q = h('input', { type: 'text', placeholder: '搜索记忆…' });
    const kindSel = h('select');
    const KINDS = [['', '全部'], ['fact', '事实'], ['preference', '偏好'], ['event', '事件'], ['person', '人物'], ['project', '项目'], ['other', '其它']];
    for (const [v, t] of KINDS) kindSel.appendChild(h('option', { value: v }, t));
    const listBox = h('div', { class: 'list' });

    async function load() {
      listBox.innerHTML = '';
      listBox.appendChild(h('div', { class: 'empty', text: '读取中…' }));
      try {
        const r = await api(`/memories?q=${encodeURIComponent(q.value)}&kind=${kindSel.value}&limit=300`);
        listBox.innerHTML = '';
        if (!r.items.length) {
          listBox.appendChild(h('div', { class: 'empty', text: '还没有形成长期记忆。多聊几次，它会在后台自己整理。' }));
          return;
        }
        for (const m of r.items) {
          const textEl = h('div', { class: 'body', text: m.text });
          const meta = h('div', { class: 'meta' }, [
            h('span', { text: fmtTime(m.ts) }),
            h('span', { class: 'tag', text: m.kind || 'fact' }),
            h('span', { class: 'tag', text: '重要度 ' + (m.salience != null ? Number(m.salience).toFixed(2) : '—') }),
            m.origin ? h('span', { class: 'tag', text: m.origin }) : null,
            m.recallCount ? h('span', { class: 'tag', text: '被想起 ' + m.recallCount + ' 次' }) : null,
            m.deleted ? h('span', { class: 'tag err', text: '已遗忘' }) : null,
          ]);
          const acts = h('div', { class: 'acts' }, [
            h('button', {
              class: 'btn ghost sm',
              text: '改',
              onclick: () => {
                const next = prompt('改写成什么？', m.text);
                if (next == null || next === m.text) return;
                api('/memories/' + m.id, { method: 'PATCH', body: { text: next } }).then(() => {
                  toast('已更新');
                  load();
                });
              },
            }),
            h('button', {
              class: 'btn ghost sm',
              text: '提高重要度',
              onclick: () =>
                api('/memories/' + m.id, { method: 'PATCH', body: { salience: Math.min(1, (m.salience || 0.7) + 0.15) } }).then(() => {
                  toast('已调整');
                  load();
                }),
            }),
            h('button', {
              class: 'btn danger sm',
              text: '忘掉',
              onclick: () => {
                if (!confirm('让它忘掉这条？')) return;
                api('/memories/' + m.id, { method: 'DELETE' }).then(() => {
                  toast('已遗忘');
                  load();
                });
              },
            }),
          ]);
          listBox.appendChild(h('div', { class: 'item' + (m.deleted ? ' gone' : '') }, [meta, textEl, acts]));
        }
      } catch (e) {
        listBox.innerHTML = '';
        listBox.appendChild(h('div', { class: 'empty', text: '读取失败：' + e.message }));
      }
    }

    let timer = null;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    });
    kindSel.addEventListener('change', load);

    // 手动添加
    const newText = h('input', { type: 'text', placeholder: '手动记一条，比如「用户对花生过敏」' });
    const newKind = h('select');
    for (const [v, t] of KINDS.slice(1)) newKind.appendChild(h('option', { value: v }, t));
    const addBtn = h('button', {
      class: 'btn',
      text: '记住',
      onclick: async () => {
        const t = newText.value.trim();
        if (!t) return;
        await api('/memories', { method: 'POST', body: { text: t, kind: newKind.value, salience: 0.85 } });
        newText.value = '';
        load();
        toast('已记住');
      },
    });

    // 召回测试
    const testQ = h('input', { type: 'text', placeholder: '输入一句话，看看它会想起什么' });
    const testOut = h('div', { class: 'list' });
    const testBtn = h('button', {
      class: 'btn ghost',
      text: '试召回',
      onclick: async () => {
        testOut.innerHTML = '';
        if (!testQ.value.trim()) return;
        try {
          const r = await api('/memories/search?q=' + encodeURIComponent(testQ.value) + '&topK=8');
          testOut.innerHTML = '';
          if (!r.hits.length) {
            testOut.appendChild(h('div', { class: 'empty', text: '什么都没想起来。' }));
            return;
          }
          for (const hit of r.hits) {
            const score = hit.score != null ? Number(hit.score).toFixed(3) : '—';
            testOut.appendChild(
              h('div', { class: 'item' }, [
                h('div', { class: 'meta' }, [
                  h('span', { class: 'tag ok', text: '得分 ' + score }),
                  hit.matched && hit.matched.length ? h('span', { class: 'tag', text: '命中：' + hit.matched.join('、') }) : null,
                  hit.item && hit.item.ts ? h('span', { text: relTime(hit.item.ts) }) : null,
                ]),
                h('div', { class: 'body', text: (hit.item && hit.item.text) || '' }),
              ])
            );
          }
        } catch (e) {
          testOut.innerHTML = '';
          testOut.appendChild(h('div', { class: 'empty', text: '失败：' + e.message }));
        }
      },
    });

    setTimeout(load, 0);

    return h('section', {}, [
      h('h1', { text: '长期记忆' }),
      h('p', { class: 'sub', text: '它记得关于你的事都在这儿。可以改、可以提高重要度，也可以让它忘掉。' }),

      h('h2', { text: '检索' }),
      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [h('div', { style: 'flex:1' }, q), kindSel]),
        h('div', { style: 'margin-top:12px' }, listBox),
      ]),

      h('h2', { text: '召回测试' }),
      h('div', { class: 'card' }, [
        h('p', { class: 'hint', text: '模拟一次检索，看它面对这句话会翻出哪些记忆、得分多少。' }),
        h('div', { class: 'row', style: 'margin-top:8px' }, [h('div', { style: 'flex:1' }, testQ), testBtn]),
        h('div', { style: 'margin-top:10px' }, testOut),
      ]),

      h('h2', { text: '手动添加' }),
      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [h('div', { style: 'flex:1' }, newText), newKind, addBtn]),
      ]),

      h('h2', { text: '相处摘要' }),
      asyncBox(
        () => api('/summaries'),
        (r) => {
          if (!r.items || !r.items.length) return h('div', { class: 'empty', text: '还没有摘要。聊够 ' + cfg('memory.summarizeEveryTurns', 10) + ' 轮就会自动生成。' });
          const list = h('div', { class: 'list' });
          for (const s of r.items) {
            list.appendChild(
              h('div', { class: 'item' }, [
                h('div', { class: 'meta' }, [
                  h('span', { text: fmtTime(s.ts) }),
                  h('span', { class: 'tag', text: '覆盖 ' + (s.covered || 0) + ' 条' }),
                ]),
                h('div', { class: 'body', text: s.text }),
              ])
            );
          }
          return list;
        }
      ),
    ]);
  }

  // ---- 情绪 ----
  function viewEmotion() {
    const canvas = h('canvas', { class: 'chart' });
    const wrap = h('div', { class: 'chart-wrap' }, [
      canvas,
      h('div', { class: 'legend' }, [
        h('span', {}, [h('i', { style: 'background:#4d8dfa' }), '你的效价']),
        h('span', {}, [h('i', { style: 'background:#ff9b9d' }), '你的唤醒']),
        h('span', {}, [h('i', { style: 'background:#7fe0b6' }), '它的心情']),
        h('span', {}, [h('i', { style: 'background:#f0b429' }), '亲密度']),
      ]),
    ]);

    async function draw() {
      let data;
      try {
        data = await api('/emotion/timeline?hours=72');
      } catch (e) {
        return;
      }
      const samples = data.samples || [];
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 640;
      const hh = canvas.clientHeight || 200;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(hh * dpr);
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, hh);

      // 网格
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = (hh / 4) * i;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
      }

      if (samples.length < 2) {
        g.fillStyle = '#616b80';
        g.font = '12px "Microsoft YaHei UI", sans-serif';
        g.fillText('还没有足够的数据。多聊几次，这里就会出现情绪曲线。', 10, hh / 2);
        return;
      }

      const t0 = samples[0].ts;
      const t1 = samples[samples.length - 1].ts;
      const span = Math.max(1, t1 - t0);
      const X = (ts) => ((ts - t0) / span) * (w - 8) + 4;
      const Y = (v) => hh / 2 - v * (hh / 2 - 8);

      function line(key, color) {
        g.beginPath();
        g.strokeStyle = color;
        g.lineWidth = 1.6;
        let started = false;
        for (const s of samples) {
          const v = s[key];
          if (v == null) continue;
          const x = X(s.ts);
          const y = Y(v);
          if (!started) {
            g.moveTo(x, y);
            started = true;
          } else g.lineTo(x, y);
        }
        g.stroke();
      }

      line('userValence', '#4d8dfa');
      line('userArousal', '#ff9b9d');
      line('petValence', '#7fe0b6');
      line('affinity', '#f0b429');

      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '11px "Microsoft YaHei UI", sans-serif';
      g.fillText(fmtTime(t0), 6, hh - 4);
      const t1Label = fmtTime(t1);
      g.fillText(t1Label, w - g.measureText(t1Label).width - 6, hh - 4);
    }

    setTimeout(draw, 30);

    const em = (S.status && S.status.emotion) || {};

    return h('section', {}, [
      h('h1', { text: '情绪' }),
      h('p', { class: 'sub', text: '它怎么读你的情绪、自己现在是什么心情，都摊在这儿。所有推断都在本机完成。' }),

      h('div', { class: 'grid c4' }, [
        statCard('它现在的心情', em.moodLabelZh || em.moodLabel || '—', em.mood ? `效价 ${em.mood.valence.toFixed(2)} / 唤醒 ${em.mood.arousal.toFixed(2)}` : '', true),
        statCard('它读到的你', em.userMoodLabelZh || em.userMoodLabel || '—', em.userMood ? `效价 ${em.userMood.valence.toFixed(2)}` : '', true),
        statCard('亲密度', ((em.affinity || 0) * 100).toFixed(0) + '%', '聊得越多越高'),
        statCard('精力', ((em.energy || 0) * 100).toFixed(0) + '%', '连聊太久它会累'),
      ]),

      h('h2', { text: '最近 72 小时' }),
      wrap,

      h('h2', { text: '三路情绪来源权重' }),
      h('div', { class: 'card' }, [
        h('p', { class: 'hint', text: '权重决定哪个通道更被相信。比如你打字多、不太说话，就把文字权重调高。' }),
        h('div', { style: 'margin-top:10px' }, [
          bar('文字', cfg('emotion.weights.text', 0), '#4d8dfa'),
          bar('声音', cfg('emotion.weights.audio', 0), '#b6a7ff'),
          bar('表情', cfg('emotion.weights.video', 0), '#3ecf8e'),
        ]),
      ]),

      h('h2', { text: '情绪来源' }),
      h('div', { class: 'card' }, [
        h('dl', { class: 'kv' }, [
          h('dt', { text: '活跃通道' }),
          h('dd', { text: (em.user && em.user.activeSources && em.user.activeSources.length) ? em.user.activeSources.join('、') : '还没有数据' }),
          h('dt', { text: '当前置信度' }),
          h('dd', { text: em.user && em.user.confidence != null ? em.user.confidence.toFixed(2) : '—' }),
        ]),
        h('div', { class: 'row', style: 'margin-top:12px' }, [
          h('button', {
            class: 'btn danger',
            text: '重置情绪状态',
            onclick: async () => {
              if (!confirm('把心情、亲密度、精力恢复初始值？')) return;
              await api('/emotion/reset', { method: 'POST' });
              toast('已重置');
              refreshStatus().then(render);
            },
          }),
        ]),
      ]),

      h('h2', { text: '参数' }),
      sectionForm('emotion'),
      saveBar(),
    ]);
  }

  function bar(name, v, color) {
    const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
    return h('div', { class: 'bar-row' }, [
      h('div', { class: 'nm', text: name }),
      h('div', { class: 'bar' }, [h('i', { style: `width:${pct}%;background:${color}` })]),
      h('div', { class: 'val', text: pct + '%' }),
    ]);
  }

  // ---- 语音 ----
  function viewVoice() {
    const box = h('section', {}, [
      h('h1', { text: '语音' }),
      h('p', { class: 'sub', text: '唤醒、识别、发声全部在本机完成：音频不会被上传到任何服务器。' }),
      h('div', { class: 'card' }, [h('div', { class: 'empty', text: '读取中…' })]),
    ]);

    (async () => {
      let v;
      try {
        v = await api('/voice');
      } catch (e) {
        box.innerHTML = '';
        box.appendChild(h('div', { class: 'empty', text: '读取失败：' + e.message }));
        return;
      }

      const asr = v.asr || {};
      const binReady = asr.binaryReady;
      const modelReady = (asr.models || []).filter((m) => m.ready).map((m) => m.id);
      const curModel = cfg('voice.asr.model', 'base');
      const modelOk = modelReady.includes(curModel);

      box.innerHTML = '';

      // 状态
      box.appendChild(h('h2', { text: '组件状态' }));
      box.appendChild(
        h('div', { class: 'card' }, [
          h('dl', { class: 'kv' }, [
            h('dt', { text: '识别引擎' }),
            h('dd', {}, [h('span', { class: 'tag ' + (binReady ? 'ok' : 'warn'), text: binReady ? 'whisper.cpp 已就绪' : '还没安装' })]),
            h('dt', { text: '语音模型' }),
            h('dd', {
              text: modelReady.length
                ? modelReady.join('、') + (modelOk ? `（当前使用 ${curModel}）` : `，但当前配置指向 ${curModel}，还没下载`)
                : '一个都还没下载',
            }),
            h('dt', { text: '存放位置' }),
            h('dd', { class: 'mono', text: asr.home || '—' }),
            h('dt', { text: '发声方式' }),
            h('dd', { text: v.tts && v.tts.backend === 'sapi' ? `Windows 系统语音（${(v.tts.voices || []).length} 个音色可用）` : (v.tts && v.tts.backend) || '—' }),
          ]),

          h('div', { class: 'row', style: 'margin-top:12px' }, [
            h('select', { id: 'asrSize' }, (asr.availableSizes || ['tiny', 'base', 'small', 'medium']).map((s) => {
              const meta = (asr.models || []).find((m) => m.id === s) || {};
              const o = h('option', { value: s }, `${s}（约 ${meta.mb || '?'} MB，${meta.note || ''}${meta.ready ? '，已下载' : ''}）`);
              if (s === curModel) o.selected = true;
              return o;
            })),
            h('button', { class: 'btn', text: '下载语音组件', onclick: doDownload }),
          ]),

          h('div', { id: 'jobBox', style: 'margin-top:12px' }),

          h('div', { class: 'row', style: 'margin-top:10px' }, [
            h('button', {
              class: 'btn ghost sm',
              text: '删除已下载的语音组件',
              onclick: async () => {
                if (!confirm('删除后语音识别会停用，需要重新下载。')) return;
                await api('/runtime/speech/remove', { method: 'POST' });
                toast('已删除');
                render();
              },
            }),
          ]),
        ])
      );

      // 唤醒
      box.appendChild(h('h2', { text: '唤醒与监听' }));
      box.appendChild(
        h('div', { class: 'card' }, [
          h('p', {
            class: 'hint',
            text: `打开监听后，叫一声「${cfg('pet.name', '它')}」，它就会进入一段活跃时间，之后的话不用再叫名字。`,
          }),
          (() => {
            const cb = h('input', { type: 'checkbox' });
            cb.checked = Boolean(cfg('voice.wake.enabled', false));
            cb.addEventListener('change', () => {
              set('voice.wake.enabled', cb.checked);
              markDirty();
              if (cb.checked && !binReady) toast('还没装语音组件，监听会一直不出结果', true);
            });
            return h('div', { class: 'field' }, [
              h('label', { text: '开启语音监听' }),
              h('div', { class: 'ctl' }, [h('label', { class: 'switch' }, [cb, cb.checked ? '已开启' : '已关闭'])]),
            ]);
          })(),
          renderField({ p: 'voice.wake.requireName', label: '每次都要叫名字', t: 'bool', hint: '关掉后活跃窗口结束后，随便说话也会被当成对话' }),
          renderField({ p: 'voice.wake.cooldownMs', label: '唤醒冷却', t: 'number', min: 0, max: 20000, step: 100, unit: '毫秒' }),
        ])
      );

      // 识别参数
      box.appendChild(h('h2', { text: '识别参数' }));
      box.appendChild(sectionForm2('voice.asr'));

      // 断句
      box.appendChild(h('h2', { text: '断句（什么时候算说完一句）' }));
      box.appendChild(sectionForm2('voice.vad'));

      // 发声
      box.appendChild(h('h2', { text: '发声' }));
      box.appendChild(
        h('div', { class: 'card' }, [
          renderField({ p: 'voice.autoSpeak', label: '回复时读出来', t: 'bool' }),
          renderField({
            p: 'voice.tts.backend',
            label: '发声方式',
            t: 'select',
            opts: [
              ['sapi', 'Windows 系统语音（离线，零安装）'],
              ['openai', '本地 TTS 服务（GPT-SoVITS / Kokoro 等）'],
              ['off', '关闭发声'],
            ],
            hint: '系统语音不需要装任何东西，质量一般但够用',
          }),
          (cfg('voice.tts.backend') === 'sapi'
            ? (() => {
                const voices = (v.tts && v.tts.voices) || [];
                const lang = voices.filter((x) => /^zh/i.test(x.culture));
                const list = lang.length ? lang : voices;
                if (!list.length) return h('div', { class: 'empty', text: '系统里没找到可用音色。' });
                const sel = h('select');
                sel.appendChild(h('option', { value: '' }, '自动挑选中文音色'));
                for (const x of list) {
                  const o = h('option', { value: x.name }, `${x.name}（${x.culture || '?'} / ${x.gender || '?'}）`);
                  if (cfg('voice.tts.sapiVoice') === x.name) o.selected = true;
                  sel.appendChild(o);
                }
                sel.addEventListener('change', () => {
                  set('voice.tts.sapiVoice', sel.value);
                  markDirty();
                });
                return h('div', { class: 'field' }, [h('label', { text: '音色' }), h('div', { class: 'ctl' }, [sel])]);
              })()
            : null),
          renderField({ p: 'voice.tts.rate', label: '语速', t: 'range', min: -10, max: 10, step: 1 }),
          renderField({ p: 'voice.tts.volume', label: '音量', t: 'range', min: 0, max: 100, step: 5 }),
          (cfg('voice.tts.backend') === 'openai'
            ? h('div', {}, [
                renderField({ p: 'voice.tts.baseUrl', label: 'TTS 接口地址', t: 'text' }),
                renderField({ p: 'voice.tts.apiKey', label: 'TTS Key', t: 'password', secret: true, hint: '留空保持原值' }),
                renderField({ p: 'voice.tts.model', label: '音色名 / 模型', t: 'text' }),
              ])
            : null),
          h('div', { class: 'row', style: 'margin-top:10px' }, [
            h('button', {
              class: 'btn ghost',
              text: '试听一句',
              onclick: async (e) => {
                const btn = e.target;
                btn.disabled = true;
                try {
                  const r = await api('/voice/preview', { method: 'POST', body: {} });
                  toast(r.ok ? `合成成功（${r.ms} ms，${r.backend}）` : '合成失败');
                } catch (err) {
                  toast(err.message, true);
                } finally {
                  btn.disabled = false;
                }
              },
            }),
            h('button', { class: 'btn ghost', text: '刷新音色列表', onclick: () => render() }),
          ]),
        ])
      );

      box.appendChild(saveBar());
    })();

    async function doDownload() {
      const sel = document.getElementById('asrSize');
      const size = sel ? sel.value : 'base';
      const jobBox = document.getElementById('jobBox');
      try {
        await api('/runtime/speech', { method: 'POST', body: { size } });
        toast('开始下载 ' + size);
      } catch (e) {
        toast(e.message, true);
        return;
      }
      const timer = setInterval(async () => {
        try {
          const p = await api('/runtime/progress');
          const jobs = p.jobs || [];
          if (!jobs.length) return;
          jobBox.innerHTML = '';
          for (const j of jobs) {
            jobBox.appendChild(
              h('div', {}, [
                h('div', { class: 'hint', text: `${j.label} · ${j.state === 'done' ? '完成' : j.state === 'error' ? '失败：' + j.message : j.percent + '%'}` }),
                h('div', { class: 'progress' }, [h('i', { style: `width:${j.percent}%` })]),
              ])
            );
          }
          if (jobs.every((j) => j.state !== 'running')) {
            clearInterval(timer);
            setTimeout(() => {
              toast('语音组件已就绪');
              render();
            }, 1200);
          }
        } catch {
          /* ignore */
        }
      }, 900);
    }

    return box;
  }

  /** 子表（voice.asr / voice.vad）也走同一张 FIELDS 表 */
  function sectionForm2(prefix) {
    const specs = FIELDS[prefix] || [];
    return h('div', { class: 'card' }, specs.map(renderField));
  }

  // 语音子项的字段定义（在 FIELDS 之外补上，保持主表清爽）
  FIELDS['voice.asr'] = [
    { p: 'voice.asr.language', label: '识别语言', t: 'select', opts: [['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['auto', '自动']] },
    { p: 'voice.asr.threads', label: 'CPU 线程', t: 'number', min: 1, max: 32, step: 1, hint: '线程越多越快，但会更吃 CPU' },
    { p: 'voice.asr.model', label: '使用的模型规格', t: 'select', opts: [['tiny', 'tiny（最快，约 75MB）'], ['base', 'base（推荐，约 142MB）'], ['small', 'small（更准，约 466MB）'], ['medium', 'medium（最准，约 1500MB）']] },
    { p: 'voice.asr.binPath', label: '自定义引擎路径', t: 'text', hint: '留空使用自动安装的位置；懂行的话可以指向自编译的 whisper-cli.exe' },
  ];
  FIELDS['voice.vad'] = [
    { p: 'voice.vad.thresholdDb', label: '静音阈值', t: 'number', min: -80, max: -10, step: 1, unit: 'dB', hint: '环境吵就调高（更接近 0）' },
    { p: 'voice.vad.minSpeechMs', label: '最短有效语音', t: 'number', min: 60, max: 2000, step: 20, unit: '毫秒' },
    { p: 'voice.vad.endSilenceMs', label: '停顿多久算说完', t: 'number', min: 200, max: 4000, step: 50, unit: '毫秒' },
    { p: 'voice.vad.maxUtteranceMs', label: '一句话最长', t: 'number', min: 3000, max: 60000, step: 1000, unit: '毫秒' },
  ];

  // ---- 桌宠 ----
  function viewPet() {
    const models = S.models || [];
    const cur = models.find((m) => m.id === cfg('pet.model'));
    return h('section', {}, [
      h('h1', { text: '桌宠' }),
      h('p', { class: 'sub', text: '外观、行为、气泡都在这里调。改完点保存，它会立刻变。' }),

      cur
        ? h('div', { class: 'card' }, [
            h('dl', { class: 'kv' }, [
              h('dt', { text: '当前模型' }), h('dd', { text: cur.id }),
              h('dt', { text: '表情' }), h('dd', { text: cur.expressions.join('、') || '无' }),
              h('dt', { text: '动作组' }), h('dd', { text: cur.motions.map((m) => `${m.group}(${m.count})`).join('、') || '无' }),
              h('dt', { text: '贴图' }), h('dd', { text: cur.textures + ' 张' }),
            ]),
          ])
        : null,

      h('h2', { text: '外观与位置' }),
      sectionForm('pet'),

      h('h2', { text: '试试看' }),
      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [
          h('button', { class: 'btn ghost', text: '让它说一句', onclick: promptSay }),
          h('button', {
            class: 'btn ghost',
            text: '让它动一下',
            onclick: () =>
              api('/pet/say', { method: 'POST', body: { text: '嘿，看这里。', speak: false } })
                .then(() => toast('已触发'))
                .catch((e) => toast(e.message, true)),
          }),
          h('button', { class: 'btn ghost', text: '重置到右下角', onclick: () => api('/pet/position/reset', { method: 'POST' }).then(() => toast('已重置')) }),
        ]),
      ]),
      saveBar(),
    ]);
  }

  // ---- 模型与人格 ----
  function viewLLM() {
    const configured = S.status && S.status.model && S.status.model.configured;
    const testOut = h('div', { class: 'hint' });
    return h('section', {}, [
      h('h1', { text: '模型与人格' }),
      h('p', { class: 'sub', text: '对话走你自己配置的接口。这里填的东西只存在本机。' }),

      h('div', { class: 'card' }, [
        h('div', { class: 'row' }, [
          h('span', { class: 'tag ' + (configured ? 'ok' : 'warn'), text: configured ? '已配置' : '未配置（当前用内置规则兜底）' }),
          h('button', {
            class: 'btn ghost sm',
            text: '测试连接',
            onclick: async (e) => {
              e.target.disabled = true;
              testOut.textContent = '测试中…';
              try {
                const r = await api('/config/test-llm', { method: 'POST', body: buildPayload().llm });
                testOut.textContent = r.ok ? `连接成功：${r.model || ''} ${r.ms ? r.ms + 'ms' : ''}` : '失败：' + (r.error || '未知错误');
              } catch (err) {
                testOut.textContent = '失败：' + err.message;
              } finally {
                e.target.disabled = false;
              }
            },
          }),
        ]),
        testOut,
      ]),

      h('h2', { text: '接口' }),
      sectionForm('llm'),

      h('h2', { text: '人格' }),
      sectionForm('persona'),

      h('h2', { text: '记忆与上下文' }),
      sectionForm('memory'),

      h('h2', { text: '管理页' }),
      sectionForm('console'),

      saveBar(),

      h('h2', { text: '危险操作' }),
      h('div', { class: 'card' }, [
        h('button', {
          class: 'btn danger',
          text: '恢复全部默认设置',
          onclick: async () => {
            if (!confirm('所有设置（含 API Key）都会恢复默认，确定吗？')) return;
            await api('/config/reset', { method: 'POST' });
            toast('已恢复默认');
            await bootstrap();
          },
        }),
      ]),
    ]);
  }

  // ---- 日志 ----
  function viewLogs() {
    const pre = h('pre', { class: 'log', text: '读取中…' });
    let timer = null;
    const auto = h('input', { type: 'checkbox' });
    auto.checked = true;

    async function load() {
      try {
        const r = await api('/logs?lines=400');
        pre.textContent = (r.lines || []).join('\n') || '（还没有日志）';
        pre.scrollTop = pre.scrollHeight;
      } catch (e) {
        pre.textContent = '读取失败：' + e.message;
      }
    }

    function tick() {
      clearInterval(timer);
      if (auto.checked) timer = setInterval(load, 3000);
    }
    auto.addEventListener('change', tick);

    load().then(tick);
    window.addEventListener(
      'hashchange',
      () => {
        clearInterval(timer);
      },
      { once: true }
    );

    return h('section', {}, [
      h('h1', { text: '日志' }),
      h('p', { class: 'sub', text: '出问题的时候，先看这里。' }),
      h('div', { class: 'row', style: 'margin-bottom:10px' }, [
        h('label', { class: 'switch' }, [auto, '自动刷新']),
        h('button', { class: 'btn ghost sm', text: '立即刷新', onclick: load }),
      ]),
      pre,
    ]);
  }

  // ------------------------------------------------------------ 路由

  const VIEWS = {
    overview: viewOverview,
    chat: viewChat,
    memory: viewMemory,
    emotion: viewEmotion,
    voice: viewVoice,
    pet: viewPet,
    llm: viewLLM,
    logs: viewLogs,
  };

  function go(name) {
    location.hash = '#/' + name;
  }

  function render() {
    const main = document.getElementById('main');

    // 配置还没到位时先占位：有些视图要读 S.cfg，直接渲染会抛错
    if (!S.cfg) {
      main.innerHTML = '';
      main.appendChild(h('div', { class: 'empty', text: '正在连接桌宠…' }));
      return;
    }

    const name = VIEWS[S.route] ? S.route : 'overview';
    main.innerHTML = '';
    try {
      main.appendChild(VIEWS[name]());
    } catch (err) {
      console.error('[控制台] 渲染失败', err);
      main.innerHTML = '';
      main.appendChild(h('div', { class: 'empty', text: '这个页面没能画出来：' + (err && err.message ? err.message : err) }));
    }
    main.scrollTop = 0;

    document.querySelectorAll('#nav a').forEach((a) => {
      a.className = a.getAttribute('data-route') === name ? 'on' : '';
    });
  }

  function buildNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = '';
    for (const [id, label] of NAV) {
      nav.appendChild(h('a', { href: '#/' + id, 'data-route': id, text: label }));
    }
  }

  function onHash() {
    const m = /^#\/(\w+)/.exec(location.hash || '');
    S.route = m ? m[1] : 'overview';
    render();
  }

  // ------------------------------------------------------------ 状态轮询

  async function refreshStatus() {
    try {
      S.status = await api('/status');
      const dot = document.getElementById('statusDot');
      const txt = document.getElementById('statusText');
      const ok = S.status.model && S.status.model.configured;
      dot.className = 'dot ' + (ok ? 'ok' : 'warn');
      txt.textContent = ok ? '运行中 · 模型已连接' : '运行中 · 本地模式';
      document.getElementById('brandSub').textContent = `管理台 · ${S.status.memory.messages} 条对话`;
    } catch (e) {
      document.getElementById('statusDot').className = 'dot err';
      document.getElementById('statusText').textContent = '连接不上桌宠';
    }
  }

  async function bootstrap() {
    S.cfg = await api('/config');
    S.draft = JSON.parse(JSON.stringify(S.cfg));
    S.dirty = false;
    try {
      const m = await api('/live2d/models');
      S.models = m.models || [];
    } catch {
      S.models = [];
    }
    await refreshStatus();
    render();
  }

  document.getElementById('btnToPet').addEventListener('click', () => {
    api('/pet/front', { method: 'POST' })
      .then(() => toast('已把桌宠叫到前面'))
      .catch((e) => toast(e.message, true));
  });

  window.addEventListener('hashchange', onHash);
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  buildNav();
  onHash();
  bootstrap().catch((e) => {
    document.getElementById('main').innerHTML = '';
    document.getElementById('main').appendChild(h('div', { class: 'empty', text: '初始化失败：' + e.message }));
  });
  setInterval(refreshStatus, 8000);
})();
