/**
 * 麦克风采集 + 本地 VAD + 声学特征。
 *
 * 采集在 AudioWorklet 里完成（16kHz 单声道），VAD 与特征计算放在主线程：
 * 计算量很小，但可读性、可调试性好很多。
 * 只有 VAD 判定「一段话结束」时才把音频交给主进程，避免持续上传。
 */

const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      // 复制一份，避免底层缓冲区被复用
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('pet-capture', CaptureProcessor);
`;

const DEFAULT_VAD = {
  thresholdDb: -44, // 相对噪声底噪的抬升阈值在下面另算
  minSpeechMs: 240,
  endSilenceMs: 900,
  maxUtteranceMs: 20000,
};

function rmsToDb(rms) {
  return 20 * Math.log10(Math.max(rms, 1e-7));
}

export class MicCapture extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.running = false;

    this.noiseFloorDb = -60;
    this.voiced = false;
    this.buffer = [];
    this.bufferMs = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.frameStats = [];
    this.prerollMs = 300;
    this.preroll = [];
    this.prerollLen = 0;
    this.config = { ...DEFAULT_VAD };
  }

  setVad(cfg = {}) {
    this.config = { ...DEFAULT_VAD, ...cfg };
  }

  async start() {
    if (this.running) return true;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    // 直接以 16kHz 建上下文，省掉自己重采样
    this.ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pet-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    this.node.port.onmessage = (e) => this._onFrame(e.data);
    this.source.connect(this.node);

    this.running = true;
    return true;
  }

  stop() {
    this.running = false;
    try {
      this.node && this.node.port.close();
      this.node && this.node.disconnect();
      this.source && this.source.disconnect();
    } catch {
      /* ignore */
    }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }

  _onFrame(frame) {
    if (!this.running) return;
    const sr = this.ctx ? this.ctx.sampleRate : 16000;
    const frameMs = (frame.length / sr) * 1000;

    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const db = rmsToDb(rms);

    // 自适应噪声底：没有语音时缓慢跟随
    if (!this.voiced) {
      this.noiseFloorDb = this.noiseFloorDb * 0.995 + db * 0.005;
    }
    const openThreshold = Math.max(this.config.thresholdDb, this.noiseFloorDb + 9);
    const closeThreshold = openThreshold - 4;

    this.dispatchEvent(new CustomEvent('level', { detail: { db, voiced: this.voiced } }));

    if (!this.voiced) {
      // 保留一小段前置音频，避免把第一个字切掉
      this.preroll.push(frame);
      this.prerollLen += frame.length;
      const maxPreroll = Math.round((this.prerollMs / 1000) * sr);
      while (this.prerollLen > maxPreroll && this.preroll.length > 1) {
        this.prerollLen -= this.preroll.shift().length;
      }

      if (db > openThreshold) {
        this.voiced = true;
        this.speechMs = frameMs;
        this.silenceMs = 0;
        this.buffer = [...this.preroll];
        this.bufferMs = (this.prerollLen / sr) * 1000;
        this.frameStats = [{ db, voiced: true, ms: frameMs }];
        this.preroll = [];
        this.prerollLen = 0;
        this.dispatchEvent(new CustomEvent('speechstart', {}));
      }
      return;
    }

    // 语音中
    this.buffer.push(frame);
    this.bufferMs += frameMs;
    const isVoiced = db > closeThreshold;
    if (isVoiced) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }
    this.frameStats.push({ db, voiced: isVoiced, ms: frameMs });

    const tooLong = this.bufferMs >= this.config.maxUtteranceMs;
    const ended =
      (this.silenceMs >= this.config.endSilenceMs && this.speechMs >= this.config.minSpeechMs) || tooLong;

    if (ended) {
      const payload = this._finalize(sr, tooLong ? 'maxLength' : 'silence');
      this.voiced = false;
      this.buffer = [];
      this.bufferMs = 0;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.frameStats = [];
      if (payload) this.dispatchEvent(new CustomEvent('utterance', { detail: payload }));
    }
  }

  _finalize(sampleRate, reason) {
    // 裁掉尾部静音，保留 150ms 余韵
    const sr = sampleRate;
    const keepTail = Math.round(0.15 * sr);
    const total = this.buffer.reduce((s, f) => s + f.length, 0);
    if (total < sr * 0.12) return null;

    const merged = new Float32Array(total);
    let off = 0;
    for (const f of this.buffer) {
      merged.set(f, off);
      off += f.length;
    }

    const voicedStats = this.frameStats.filter((s) => s.voiced);
    const allDb = this.frameStats.map((s) => s.db);
    const durationMs = (total / sr) * 1000;

    const trimEnd = Math.max(0, merged.length - keepTail);
    const samples = merged.subarray(0, trimEnd || merged.length);

    const features = {
      durationMs,
      rmsDb: mean(voicedStats.map((s) => s.db)) || mean(allDb) || -45,
      peakDb: Math.max(...allDb, -80),
      voicedRatio: voicedStats.length / Math.max(1, this.frameStats.length),
      pauseRatio: 1 - voicedStats.length / Math.max(1, this.frameStats.length),
      endReason: reason,
      sampleRate: sr,
    };

    const pitch = estimatePitch(samples, sr);
    features.pitchMean = pitch.mean;
    features.pitchVar = pitch.variance;
    features.voicedRatioPitch = pitch.voicedRatio;

    return { samples: new Float32Array(samples), features };
  }
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/**
 * 自相关法估基频（80~400Hz），只取有声帧。
 * 够用即可：用来判断语速/音高的整体走向，不做精确的音高分析。
 */
function estimatePitch(samples, sr) {
  const fmin = 80;
  const fmax = 400;
  const minLag = Math.floor(sr / fmax);
  const maxLag = Math.floor(sr / fmin);
  const frameLen = Math.floor(sr * 0.04); // 40ms
  const hop = Math.floor(frameLen / 2);

  const pitches = [];
  for (let start = 0; start + frameLen < samples.length; start += hop) {
    const seg = samples.subarray(start, start + frameLen);
    let energy = 0;
    for (let i = 0; i < seg.length; i++) energy += seg[i] * seg[i];
    if (energy / seg.length < 1e-5) continue;

    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag && lag < seg.length; lag++) {
      let corr = 0;
      for (let i = 0; i < seg.length - lag; i++) corr += seg[i] * seg[i + lag];
      corr /= seg.length - lag;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    if (bestLag > 0 && bestCorr > 1e-4) pitches.push(sr / bestLag);
  }

  if (pitches.length < 3) return { mean: 0, variance: 0, voicedRatio: 0 };
  const m = mean(pitches);
  const variance = mean(pitches.map((p) => (p - m) ** 2));
  return { mean: m, variance, voicedRatio: pitches.length };
}

export { rmsToDb };
