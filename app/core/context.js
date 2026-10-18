'use strict';
/**
 * 上下文组装。
 *
 * 原则（和参考项目的记忆设计一致）：
 *  1. 先接住刚才的话——最近几轮完整保留，不做裁剪；
 *  2. 长期记忆只放被检索到的少量高相关片段，并标注来源，避免污染人格；
 *  3. 情绪作为「背景线索」注入，不作为事实复述；
 *  4. 注入的内容都包在明确的标签里，模型能分清哪些是资料、哪些是当前对话。
 */
const { LABEL_HINT } = require('./emotion/lexicon');

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relativeDay(ts, now) {
  const a = new Date(ts);
  const b = new Date(now);
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  const diff = Math.round((db - da) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff < 7) return `${diff} 天前`;
  if (diff < 30) return `${Math.floor(diff / 7)} 周前`;
  if (diff < 365) return `${Math.floor(diff / 30)} 个月前`;
  return `${Math.floor(diff / 365)} 年前`;
}

function buildSystemPrompt({ config, emotion, memories, summary, now }) {
  const cfg = config;
  const pet = cfg.pet || {};
  const parts = [];

  parts.push(cfg.persona?.prompt || '你是一只桌宠，请用简短口语化的中文回应。');

  const runtime = [];
  runtime.push(`当前时间：${fmtTime(now)}（星期${'日一二三四五六'[new Date(now).getDay()]}）`);
  runtime.push(`你的名字是「${pet.name || '小满'}」，用户平时可以这样叫你。`);
  if (pet.aliases && pet.aliases.length > 1) {
    runtime.push(`用户也可能叫你：${pet.aliases.filter((a) => a !== pet.name).join('、')}。`);
  }
  runtime.push(`用户希望被称呼为：${cfg.persona?.userNickname || '你'}。`);

  if (emotion) {
    const moodZh = `你自己的心情：${moodText(emotion.mood)}`;
    const userZh = `用户此刻的情绪线索：${LABEL_HINT[emotion.userMoodLabel] || '中性'}（置信度 ${Math.round(
      (emotion.userConfidence || 0) * 100
    )}%）`;
    runtime.push(moodZh);
    runtime.push(userZh);
    runtime.push(`相处亲密度：${Math.round((emotion.affinity || 0) * 100)}%（越高越熟络，可以更放松、更少客套）`);
    if ((emotion.energy || 1) < 0.3) runtime.push('你现在有点累，回复可以更简短、更懒散一点。');
  }
  parts.push(`【当前状态】\n${runtime.join('\n')}`);

  if (summary && summary.text) {
    parts.push(`【更早之前的相处摘要（供参考，不要生硬复述）】\n${summary.text}`);
  }

  if (memories && memories.length) {
    const lines = memories.map((m, i) => `${i + 1}. (${kindZh(m.item.kind)}，${relativeDay(m.item.ts, now)}) ${m.item.text}`);
    parts.push(`【你可能记得的关于用户的事（按相关度排序，不确定就不要提）】\n${lines.join('\n')}`);
  }

  parts.push(
    '【输出要求】直接输出你要说的话本身，不要写旁白、动作描写或括号说明，不要用 Markdown 列表与标题。' +
      '长度通常 1~3 句；用户明显在讲长事情、或明确要求详细说明时才可以变长。'
  );

  return parts.join('\n\n');
}

function moodText(mood) {
  if (!mood) return '平静';
  const { valence: v, arousal: a } = mood;
  if (v >= 0.3 && a >= 0.6) return '很有精神、开心';
  if (v >= 0.3) return '心情不错';
  if (v <= -0.3 && a >= 0.6) return '有点急躁';
  if (v <= -0.3) return '有点低落';
  if (a <= 0.2) return '安静、有点困';
  return '平静';
}

function kindZh(kind) {
  return { fact: '事实', preference: '偏好', relation: '关系', event: '事件', summary: '摘要' }[kind] || '记录';
}

/**
 * @param {object} p
 * @param {object} p.config 当前配置快照
 * @param {string} p.userText 用户这一句
 * @param {Array}  p.recent 最近的消息记录
 * @param {Array}  p.memories 检索到的长期记忆 [{item, score, matched}]
 * @param {object} p.summary 最新摘要
 * @param {object} p.emotion 情绪快照
 * @param {Array}  p.attachments 额外注入（图片描述、语音转写备注等）
 */
function buildContext({ config, userText, recent = [], memories = [], summary = null, emotion = null, attachments = [], now = Date.now() }) {
  const messages = [];
  messages.push({ role: 'system', content: buildSystemPrompt({ config, emotion, memories, summary, now }) });

  const turns = config.memory?.recentTurns || 12;
  const window = recent.slice(-Math.max(2, turns * 2));
  for (const m of window) {
    if (!m.text) continue;
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.text });
    } else if (m.role === 'pet') {
      messages.push({ role: 'assistant', content: m.text });
    }
  }

  if (attachments.length) {
    messages.push({
      role: 'system',
      content: `【本轮附加信息】\n${attachments.join('\n')}`,
    });
  }

  messages.push({ role: 'user', content: userText });

  return {
    messages,
    debug: {
      recentCount: window.length,
      memoryCount: memories.length,
      memoryIds: memories.map((m) => m.item.id),
      summaryId: summary ? summary.id : null,
      hasSummary: Boolean(summary && summary.text),
      promptChars: messages.reduce((s, m) => s + m.content.length, 0),
    },
  };
}

module.exports = { buildContext, buildSystemPrompt, fmtTime, relativeDay, kindZh };
