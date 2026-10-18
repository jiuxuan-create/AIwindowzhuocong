/**
 * 摄像头情绪：MediaPipe FaceLandmarker 的 52 个 blendshape 系数 → 面部线索。
 *
 * 完全本地推理（WASM / WebGL），不出图、不录视频、不上传：
 * 只把「系数」这一组数字交给主进程参与情绪融合，视频帧不离开渲染进程。
 * 默认关闭，用户必须在管理页显式打开。
 */

const BLENDSHAPE_KEYS = [
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'cheekSquintLeft',
  'cheekSquintRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawOpen',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
];

export class FaceEmotion extends EventTarget {
  constructor() {
    super();
    this.landmarker = null;
    this.video = null;
    this.stream = null;
    this.running = false;
    this.latest = null;
    this.faceScore = 0;
    this.intervalMs = 4000;
    this._lastRun = 0;
    this._raf = null;
  }

  get ready() {
    return Boolean(this.landmarker);
  }

  async load({ modelUrl = 'app://local/__runtime__/mediapipe/face_landmarker.task' } = {}) {
    if (this.landmarker) return this.landmarker;
    const mod = await import('./vendor/mediapipe/vision_bundle.mjs');
    const fileset = await mod.FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');
    this.landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
      runningMode: 'VIDEO',
      numFaces: 1,
    });
    return this.landmarker;
  }

  async start({ intervalMs = 4000 } = {}) {
    if (this.running) return true;
    this.intervalMs = intervalMs;
    await this.load();

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, frameRate: 12 },
      audio: false,
    });
    this.video = document.getElementById('camera');
    if (!this.video) {
      this.video = document.createElement('video');
      this.video.id = 'camera';
      this.video.className = 'camera-video';
      this.video.muted = true;
      this.video.playsInline = true;
      document.body.appendChild(this.video);
    }
    this.video.srcObject = this.stream;
    await this.video.play();

    this.running = true;
    this._lastRun = 0;
    this._tick();
    return true;
  }

  _tick() {
    if (!this.running) return;
    const now = performance.now();
    if (now - this._lastRun >= this.intervalMs && this.video && this.video.readyState >= 2) {
      this._lastRun = now;
      try {
        const res = this.landmarker.detectForVideo(this.video, now);
        this._consume(res);
      } catch (err) {
        console.warn('[camera] 识别失败', err);
      }
    }
    this._raf = requestAnimationFrame(() => this._tick());
  }

  _consume(res) {
    const cat = res && res.faceBlendshapes && res.faceBlendshapes[0];
    if (!cat || !cat.categories) {
      this.latest = null;
      this.faceScore = 0;
      return;
    }
    const map = {};
    for (const c of cat.categories) {
      map[c.categoryName] = c.score;
    }
    const picked = {};
    for (const k of BLENDSHAPE_KEYS) picked[k] = map[k] ?? 0;
    this.latest = picked;
    // 用「表情活跃度」反映检测质量，全 0 说明没检测到有效人脸
    this.faceScore =
      Object.values(picked).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(picked).length);
    this.dispatchEvent(new CustomEvent('sample', { detail: { blendshapes: picked, score: this.faceScore } }));
  }

  /** 取最近一次结果；太旧或没有脸就返回 null */
  sample(maxAgeMs = 15000) {
    if (!this.latest) return null;
    if (performance.now() - this._lastRun > maxAgeMs) return null;
    if (this.faceScore < 0.02) return null;
    return { ...this.latest };
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.latest = null;
  }

  dispose() {
    this.stop();
    try {
      this.landmarker && this.landmarker.close();
    } catch {
      /* ignore */
    }
    this.landmarker = null;
  }
}
