'use strict';
/**
 * 对话编排层：把「输入 → 情绪 → 记忆 → 上下文 → 生成 → 落库」串起来。
 *
 * 这里是唯一允许写记忆、改情绪的地方，其他模块只做纯计算，便于排查问题。
 */
const { EventEmitter } = require('node:events');
const { scoped } = require('./logger');
const { buildContext } = require('./context');
const { fuse, fromText, fromAcoustic, fromVisual } = require('./emotion/fusion');
const { scoreText, LABEL_ZH } = require('./emotion/lexicon');
const { LocalPersona } = require('./persona-local');

const log = scoped('chat');

const MARKDOWN_RULES = [
  [/```[\s\S]*?```/g, ''],
  [/^\s{0,3}#{1,6}\s+/gm, ''],
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/(^|\n)\s*[-*+]\s+/g, '$1'],
  [/(^|\n)\s*\d+\.\s+/g, '$1'],
  [/`([^`]+)`/g, '$1'],
  [/^\s*>\s?/gm, ''],
];

function polish(text, petName) {
  let t = String(text || '').trim();
  for (const [re, rep] of MARKDOWN_RULES) t = t.replace(re, rep);
  // 去掉模型自报家门的局首前缀
  t = t.replace(new RegExp(`^[（(]?${petName}[）)]?\\s*[:：]\\s*`), '');
  t = t.replace(/^["“”']|["“”']$/g, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/** 粗略判断一轮互动是不是正面的，用于亲密度的增量 */
function kindnessOf(text) {
  const s = scoreText(text);
  return Math.max(-1, Math.min(1, s.valence));
}

class ChatEngine extends EventEmitter {
  constructor({ config, llm, store, retriever, extractor, summarizer, emotion }) {
    super();
    this.config = config;
    this.llm = llm;
    this.store = store;
    this.retriever = retriever;
    this.extractor = extractor;
    this.summarizer = summarizer;
    this.emotion = emotion;
    this.local = new LocalPersona(() => this.config.all());
    this.inflight = null;
  }

  /** 当前是否可以走真实模型 */
  get modelReady() {
    return this.llm.isConfigured();
  }

  buildQuery(text) {
    const recentUser = this.store
      .recentMessages(8)
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.text);
    return [...recentUser, text].join(' ');
  }

  retrieve(text) {
    const cfg = this.config.all();
    if (!cfg.memory?.enabled || !cfg.memory?.longTermEnabled) return [];
    if (this.retriever.dirty) this.retriever.build(this.store.longterm);
    return this.retriever.search(this.buildQuery(text), {
      topK: cfg.memory.retrievalTopK,
      minScore: cfg.memory.minScore,
    });
  }

  /**
   * 一轮对话。
   * @param {object} p
   * @param {string} p.text
   * @param {string} [p.source] text | voice | console
   * @param {object} [p.signals] { acoustic, visual }
   * @param {Function} [p.onDelta]
   * @param {AbortSignal} [p.signal]
   */
  async send({ text, source = 'text', signals = {}, onDelta, signal, skipStore = false } = {}) {
    const cfg = this.config.all();
    const started = Date.now();
    const userText = String(text || '').trim();
    if (!userText) throw new Error('内容为空');

    this.emotion.tick();

    // ---- 1. 多源情绪 ----
    const local = scoreText(userText);
    const textSignal = fromText({
      valence: local.valence,
      arousal: local.arousal,
      confidence: local.hits.length ? Math.min(0.85, 0.45 + local.hits.length * 0.08) : 0.35,
      hits: local.hits,
    });
    const acousticSignal = signals.acoustic ? fromAcoustic(signals.acoustic) : null;
    const visualSignal = signals.visual ? fromVisual(signals.visual) : null;

    const fused = fuse(
      { text: textSignal, acoustic: acousticSignal, visual: visualSignal },
      {
        weights: cfg.emotion?.weights,
        enabled: {
          text: cfg.emotion?.textEnabled !== false,
          audio: cfg.emotion?.audioEnabled !== false,
          video: cfg.emotion?.videoEnabled === true,
        },
        previous: this.emotion.data.userMood,
        inertia: 0.25,
      }
    );

    this.emotion.observeUser(fused);
    const beforeSnap = this.emotion.snapshot();

    // ---- 2. 落库用户消息 ----
    let userMsg = null;
    if (!skipStore) {
      userMsg = this.store.addMessage({
        role: 'user',
        text: userText,
        source,
        emotion: {
          fused,
          userMoodAt: beforeSnap.userMood,
          petMoodAt: beforeSnap.mood,
          label: LABEL_ZH[fused.label] || fused.label,
        },
        meta: {
          acoustic: signals.acoustic || null,
          visual: signals.visual ? summarizeVisual(signals.visual) : null,
          latencyMs: null,
        },
      });
    }

    // ---- 3. 记忆检索 ----
    const memories = this.retrieve(userText);
    if (memories.length) this.store.noteRecall(memories.map((m) => m.item.id));
    const summary = this.store.latestSummary();

    // ---- 4. 组装上下文 ----
    const attachments = [];
    if (signals.acoustic && cfg.emotion?.audioEnabled !== false) {
      if (signals.acoustic.rmsDb != null) {
        attachments.push(
          `用户这一句是语音输入：平均音量 ${Number(signals.acoustic.rmsDb).toFixed(0)}dB，语速约 ${Number(
            signals.acoustic.speechRate || 0
          ).toFixed(1)} 字/秒，停顿占比 ${(Number(signals.acoustic.pauseRatio || 0) * 100).toFixed(0)}%。`
        );
      }
    }
    if (visualSignal && cfg.emotion?.videoEnabled) {
      attachments.push(`摄像头观察到的面部线索：${describeVisual(visualSignal)}`);
    }

    const { messages, debug } = buildContext({
      config: cfg,
      userText,
      recent: this.store.messages,
      memories,
      summary,
      emotion: { ...beforeSnap, userConfidence: fused.confidence },
      attachments,
    });

    // ---- 5. 生成 ----
    let replyText = '';
    let usedModel = false;
    let finish = null;
    let llmError = null;

    if (this.modelReady) {
      try {
        const r = await this.llm.streamChat(messages, {
          onDelta: (piece, full) => {
            if (onDelta) onDelta(piece, full);
          },
          signal,
        });
        replyText = r.text;
        finish = r.finish;
        usedModel = true;
      } catch (err) {
        llmError = err;
        log.warn('模型调用失败', err.message);
        if (!cfg.llm.fallback) throw err;
      }
    }

    if (!usedModel) {
      replyText = this.local.reply(userText, {
        emotion: beforeSnap,
        memories,
        notice: llmError ? false : true,
      });
      if (llmError && onDelta) onDelta(replyText, replyText);
    }

    replyText = polish(replyText, cfg.pet.name);
    if (!replyText) replyText = '……我这边没组织好语言，你再说一遍？';

    // ---- 6. 情绪反应与落库 ----
    const snapAfter = this.emotion.react({
      userValence: fused.valence,
      kindness: kindnessOf(userText),
      kind: detectKind(userText),
    });

    let petMsg = null;
    if (!skipStore) {
      petMsg = this.store.addMessage({
        role: 'pet',
        text: replyText,
        source: usedModel ? 'model' : 'local',
        emotion: {
          fused,
          userMoodAt: snapAfter.userMood,
          petMoodAt: snapAfter.mood,
          label: LABEL_ZH[fused.label] || fused.label,
        },
        meta: {
          usedModel,
          model: usedModel ? cfg.llm.model : null,
          latencyMs: Date.now() - started,
          finish,
          error: llmError ? llmError.message : null,
          replyTo: userMsg ? userMsg.id : null,
          context: debug,
        },
      });
    }

    this.store.addEmotionSample({
      ts: Date.now(),
      userValence: Number(fused.valence.toFixed(3)),
      userArousal: Number(fused.arousal.toFixed(3)),
      userLabel: fused.label,
      petValence: Number(snapAfter.mood.valence.toFixed(3)),
      petArousal: Number(snapAfter.mood.arousal.toFixed(3)),
      petLabel: snapAfter.moodLabel,
      affinity: Number(snapAfter.affinity.toFixed(3)),
      energy: Number(snapAfter.energy.toFixed(3)),
      confidence: fused.confidence,
      source,
      usedModel,
    });

    // ---- 7. 后台整理记忆（不阻塞对话） ----
    setImmediate(() => this.backgroundIntegrate().catch((e) => log.warn('后台整理失败', e.message)));

    const result = {
      reply: replyText,
      usedModel,
      model: usedModel ? cfg.llm.model : null,
      latencyMs: Date.now() - started,
      emotion: {
        user: { ...fused, labelZh: LABEL_ZH[fused.label] || fused.label },
        pet: snapAfter,
      },
      memories: memories.map((m) => ({ id: m.item.id, text: m.item.text, score: Number(m.score.toFixed(3)) })),
      context: debug,
      error: llmError ? llmError.message : null,
      userMessageId: userMsg ? userMsg.id : null,
      petMessageId: petMsg ? petMsg.id : null,
    };
    this.emit('turn', result);
    return result;
  }

  /** 抽取长期记忆 + 滚动摘要，二者都在后台跑 */
  async backgroundIntegrate() {
    const cfg = this.config.all();
    if (!cfg.memory?.enabled) return;
    const recent = this.store.messages.slice(-6);
    if (recent.length) {
      await this.extractor.extractFrom(recent);
      this.retriever.dirty = true;
    }
    if (this.summarizer.tick()) {
      await this.summarizer.maybeSummarize();
    }
  }

  /** 桌宠主动搭话（不调用模型，零成本，避免打扰） */
  proactiveLine() {
    const cfg = this.config.all();
    if (cfg.pet.silentMode) return null;
    const snap = this.emotion.snapshot();
    const hour = new Date().getHours();
    const last = snap.lastInteractionTs || 0;
    const gapMin = (Date.now() - last) / 60000;

    const pool = [];
    if (hour >= 23 || hour < 5) pool.push('这么晚了还醒着呀。', '再不睡，明天会很难受的哦。');
    if (hour >= 11 && hour <= 13) pool.push('中午了，记得吃点东西。', '该吃饭了，别又拖。');
    if (hour >= 17 && hour <= 19) pool.push('今天差不多了吧？', '太阳要下山了。');
    if (gapMin > 90) pool.push('好久没说话了……你还在吗？', '我在这儿待了挺久了。');
    if (snap.mood.valence < -0.2) pool.push('总觉得有点闷。', '嗯……没什么，就是想说句话。');
    if (snap.mood.valence > 0.35) pool.push('今天心情挺好的。', '在想要不要跟你搭句话。');
    if (snap.energy < 0.3) pool.push('有点困了……', '让我打个盹。');
    if (!pool.length) pool.push('……', '嗯，我在这儿。');
    return pool[Math.floor(Math.random() * pool.length)];
  }
}

function detectKind(text) {
  const t = String(text || '');
  if (/(好可爱|真可爱|喜欢你|你最好了|好棒|厉害|爱你)/.test(t)) return 'praise';
  if (/(真笨|好笨|蠢|滚开|烦人|讨厌你|闭嘴|没用)/.test(t)) return 'insult';
  if (/(摸摸|摸头|拍拍|抱抱)/.test(t)) return 'pet';
  return 'chat';
}

function summarizeVisual(v) {
  return {
    valence: Number((v.valence || 0).toFixed(3)),
    arousal: Number((v.arousal || 0).toFixed(3)),
    confidence: Number((v.confidence || 0).toFixed(3)),
    features: v.features ? roundObj(v.features) : null,
  };
}

function roundObj(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' ? Number(v.toFixed(3)) : v;
  return out;
}

function describeVisual(v) {
  const f = v.features || {};
  const bits = [];
  if (f.smile > 0.35) bits.push('嘴角上扬');
  if (f.browDown > 0.3) bits.push('眉压低');
  if (f.browInner > 0.3) bits.push('眉头内收');
  if (f.jawOpen > 0.35) bits.push('嘴张开');
  if (f.wide > 0.3) bits.push('眼睛睁大');
  if (f.frown > 0.3) bits.push('嘴角向下');
  return bits.length ? bits.join('、') + '（仅供参考，不要直接点明）' : '表情变化不明显，请不要据此推断';
}

module.exports = { ChatEngine, polish };
