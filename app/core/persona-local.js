'use strict';
/**
 * 本地人格引擎。
 * 没有配置 API Key、或模型调用失败时接管对话，保证桌宠始终能回应，
 * 并且明确告知用户「现在是本地模式」，不假装成模型回答。
 */
const { scoreText, LABEL_ZH } = require('./emotion/lexicon');

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const INTENTS = [
  {
    name: 'greeting',
    re: /^(你好|您好|哈喽|嗨|hi|hello|在吗|在么|早上好|早|中午好|下午好|晚上好|晚安)[!！。~～\s]*$/i,
  },
  { name: 'identity', re: /(你是谁|你叫什么|你的名字|你是什么|自我介绍|你都会什么|你能做什么|你会什么)/ },
  { name: 'time', re: /(几点|现在时间|今天(是)?(几号|周几|星期几)|日期)/ },
  { name: 'thanks', re: /(谢谢|感谢|多谢|辛苦了|谢谢侬)/ },
  { name: 'praise', re: /(好可爱|真可爱|好棒|厉害|喜欢你|你最好了|真好|太可爱)/ },
  { name: 'insult', re: /(真笨|好笨|蠢|滚开|烦人|讨厌你|闭嘴|没用)/ },
  { name: 'sad', re: /(难过|不开心|好累|累死|崩溃|想哭|委屈|压力好大|撑不住|孤独|焦虑)/ },
  { name: 'recall', re: /(你还记得|记不记得|之前(说|提)过|上次(说|提)) / },
  { name: 'bye', re: /(再见|拜拜|走了|下线|去睡了|先这样|晚安)/ },
  { name: 'ask_config', re: /(api|key|密钥|模型|配置|为什么这么回答|怎么变聪明)/i },
];

function timeReply(cfg) {
  const d = new Date();
  const h = d.getHours();
  let tip = '现在是白天';
  if (h >= 23 || h < 5) tip = '已经很晚了，早点休息';
  else if (h < 9) tip = '早上';
  else if (h < 12) tip = '上午';
  else if (h < 14) tip = '中午了，别忘了吃饭';
  else if (h < 18) tip = '下午';
  else tip = '晚上了';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}，${tip}。`;
}

const TEMPLATES = {
  greeting: ['嗯，我在。', '在的在的，怎么了？', '嗨，今天过得怎么样？', '我在呀，刚在发呆。'],
  sleep: ['晚安，做个好梦。', '去睡吧，我守着电脑。', '晚安，明天见。'],
  identity: [
    (c) => `我是${c.pet.name}，住在你电脑里的桌宠。`,
    (c) => `${c.pet.name}呀——会陪着你，也会记住一点你说过的事。`,
  ],
  thanks: ['不客气。', '嗯嗯，别客气~', '这有什么好谢的。'],
  praise: ['嘿嘿……被你夸得有点不好意思。', '你这么说我会当真的。', '那我今天心情很好。'],
  insult: ['……好吧，我记下了。', '哼。', '生气归生气，还是得陪你。'],
  sad: [
    '先别急着解决什么，坐一会儿也行。',
    '嗯，我听着呢，慢慢说。',
    '这样确实难受。不用马上好起来。',
    '把最烦的那件先说给我听？',
  ],
  recall: ['我这边还留着一些记录，但现在是本地模式，只能翻到最近的几句话。', '让我想想……得等接上模型我才能翻旧账。'],
  bye: ['好，那我在后台待着，随时叫我。', '嗯，我在这儿，去忙吧。'],
  idle: [
    '（我在旁边看着呢）',
    '嗯……然后呢？',
    '我在听。',
    '这个我还真答不上来。',
    '你再说详细点？',
  ],
};

const LOCAL_NOTICE =
  '（现在是本地模式：没有配置对话模型的 Key，我只能靠内置规则回应。在管理页填上 DeepSeek 的 Key，我就能真的聊天了。）';

class LocalPersona {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  detect(text) {
    const t = String(text || '').trim();
    if (!t) return { name: 'idle' };
    for (const it of INTENTS) {
      if (it.re.test(t)) return it;
    }
    if (/晚安/.test(t)) return { name: 'sleep' };
    return { name: 'idle' };
  }

  /**
   * @param {string} text
   * @param {{emotion?:object, memories?:Array, notice?:boolean}} ctx
   */
  reply(text, ctx = {}) {
    const cfg = this.getConfig();
    const intent = this.detect(text);
    const emo = ctx.emotion;
    let body;

    switch (intent.name) {
      case 'greeting':
        body = pick(TEMPLATES.greeting);
        break;
      case 'sleep':
        body = pick(TEMPLATES.sleep);
        break;
      case 'identity':
        body = pick(TEMPLATES.identity)(cfg);
        break;
      case 'time':
        body = timeReply(cfg);
        break;
      case 'thanks':
        body = pick(TEMPLATES.thanks);
        break;
      case 'praise':
        body = pick(TEMPLATES.praise);
        break;
      case 'insult':
        body = pick(TEMPLATES.insult);
        break;
      case 'sad':
        body = pick(TEMPLATES.sad);
        break;
      case 'recall': {
        const mems = ctx.memories || [];
        body = mems.length
          ? `我记得这条：${mems[0].item.text}`
          : pick(TEMPLATES.recall);
        break;
      }
      case 'bye':
        body = pick(TEMPLATES.bye);
        break;
      case 'ask_config':
        body = '在网页管理页的「模型」里填 Base URL 和 API Key 就能接上，填完点一下测试。';
        break;
      default: {
        const local = scoreText(text);
        if (local.valence <= -0.35) body = pick(TEMPLATES.sad);
        else if (local.valence >= 0.35) body = '听起来还不错。说来听听？';
        else body = pick(TEMPLATES.idle);
      }
    }

    if (emo && emo.userMoodLabel && emo.userMoodLabel !== 'calm' && intent.name === 'idle' && Math.random() < 0.35) {
      body += `（我猜你现在是${LABEL_ZH[emo.userMoodLabel] || '有点心事'}？）`;
    }
    if (ctx.notice !== false) body += '\n' + LOCAL_NOTICE;
    return body;
  }
}

module.exports = { LocalPersona, LOCAL_NOTICE };
