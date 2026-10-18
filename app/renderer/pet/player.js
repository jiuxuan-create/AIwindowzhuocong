/**
 * 语音播放 + 口型驱动。
 * 播放时用 AnalyserNode 取实时音量，作为嘴巴张合的驱动值，
 * 这样不需要额外的音素分析就能对上口型。
 */
export class VoicePlayer extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.data = null;
    this.level = 0;
    this.playing = false;
    this._raf = null;
    this._smooth = 0;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.65;
      this.data = new Uint8Array(this.analyser.fftSize);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** @param {ArrayBuffer} arrayBuffer */
  async play(arrayBuffer) {
    this.stop();
    const ctx = this._ensureCtx();
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
      console.warn('[player] 解码音频失败', err);
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
      return false;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    src.onended = () => {
      this.playing = false;
      this.level = 0;
      this._smooth = 0;
      this.dispatchEvent(new CustomEvent('ended', {}));
    };
    src.start();
    this.source = src;
    this.playing = true;
    this._loop();
    return true;
  }

  _loop() {
    if (!this.playing) return;
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.data.length);
    // 放大并压缩到 0~1，再做一个软起音，避免抖动
    const raw = Math.min(1, Math.pow(rms * 3.4, 0.7));
    this._smooth = this._smooth * 0.55 + raw * 0.45;
    this.level = this._smooth;
    this._raf = requestAnimationFrame(() => this._loop());
  }

  get currentLevel() {
    return this.playing ? this.level : 0;
  }

  stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.playing = false;
    this.level = 0;
    this._smooth = 0;
  }
}
