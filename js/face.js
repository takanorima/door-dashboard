/* =========================================================
 * face.js — 端末内だけで完結する顔認識（子どもの切替用）
 *
 * - @vladmandic/face-api（vendor/ に同梱）を必要になった時だけ読み込む
 * - 保存するのは顔の特徴ベクトル（128個の数値）だけ。写真は保存しない
 * - 保存先はこのタブレットの localStorage のみ。外部送信なし
 * ========================================================= */
(() => {
  'use strict';

  const LIB_URL = 'vendor/face-api/face-api.js';
  const MODEL_URL = 'vendor/face-api/model';
  const KEY = (memberId) => `dd:face:${memberId}`;

  const opts = {
    threshold: 0.5,      // これより距離が小さければ本人候補（小さいほど厳しい）
    margin: 0.06,        // 1位と2位の差がこれ未満なら「兄弟の区別がつかない」として保留
    confirmFrames: 2,    // 同じ子が連続で何回当たれば確定するか
    scanTimeoutMs: 8000,
    intervalMs: 350,
    samplesPerEnroll: 6,
    maxSamplesPerMember: 24,
  };

  let loading = null;
  let stream = null;

  // ---------- ライブラリ・モデル読み込み ----------
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('face-api の読み込みに失敗'));
      document.head.append(s);
    });
  }

  function ensureLoaded() {
    if (!loading) {
      loading = (async () => {
        if (!window.faceapi) await loadScript(LIB_URL);
        const fa = window.faceapi;
        await fa.tf.setBackend('webgl').catch(() => fa.tf.setBackend('cpu'));
        await fa.tf.ready();
        await Promise.all([
          fa.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          fa.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
          fa.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        return fa;
      })().catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  // ---------- カメラ ----------
  async function startCamera(video) {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
  }

  function stopCamera(video) {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  async function describe(fa, video) {
    const r = await fa
      .detectSingleFace(video, new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks(true)
      .withFaceDescriptor();
    return r ? { descriptor: r.descriptor, box: r.detection.box, score: r.detection.score } : null;
  }

  // ---------- 保存データ ----------
  function getSamples(memberId) {
    try { return (JSON.parse(localStorage.getItem(KEY(memberId))) || []).map((a) => Float32Array.from(a)); }
    catch { return []; }
  }
  function saveSamples(memberId, samples) {
    const trimmed = samples.slice(-opts.maxSamplesPerMember).map((d) => Array.from(d, (x) => +x.toFixed(5)));
    localStorage.setItem(KEY(memberId), JSON.stringify(trimmed));
  }
  function sampleCount(memberId) { return getSamples(memberId).length; }
  function clear(memberId) { localStorage.removeItem(KEY(memberId)); }
  function clearAll() {
    Object.keys(localStorage).filter((k) => k.startsWith('dd:face:')).forEach((k) => localStorage.removeItem(k));
  }

  function dist(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }

  /** descriptor を登録済みの子と照合。区別が曖昧なら null */
  function match(descriptor, memberIds) {
    const scores = memberIds
      .map((id) => {
        const s = getSamples(id);
        if (!s.length) return null;
        // 近い順に3件の平均（1枚だけ偶然近い、を防ぐ）
        const ds = s.map((x) => dist(descriptor, x)).sort((a, b) => a - b).slice(0, 3);
        return { id, d: ds.reduce((p, c) => p + c, 0) / ds.length };
      })
      .filter(Boolean)
      .sort((a, b) => a.d - b.d);
    if (!scores.length) return null;
    const [best, second] = scores;
    if (best.d > opts.threshold) return null;
    if (second && second.d - best.d < opts.margin) return null;
    return best;
  }

  // ---------- 登録 ----------
  /**
   * @param {string} memberId
   * @param {HTMLVideoElement} video
   * @param {(msg:string, n:number, total:number)=>void} onProgress
   */
  async function enroll(memberId, video, onProgress = () => {}) {
    const fa = await ensureLoaded();
    await startCamera(video);
    const got = [];
    const deadline = Date.now() + 30000;
    try {
      onProgress('カメラを見てね', 0, opts.samplesPerEnroll);
      while (got.length < opts.samplesPerEnroll && Date.now() < deadline) {
        const r = await describe(fa, video);
        if (r && r.score > 0.7) {
          got.push(r.descriptor);
          const hints = ['そのまま', 'すこし右を向いて', 'すこし左を向いて', 'すこし上を向いて', 'にっこり', 'さいご！'];
          onProgress(hints[got.length] ?? 'OK', got.length, opts.samplesPerEnroll);
          await new Promise((r) => setTimeout(r, 600));
        } else {
          onProgress('顔が見つかりません。カメラに近づいてね', got.length, opts.samplesPerEnroll);
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } finally {
      stopCamera(video);
    }
    if (got.length < 3) throw new Error('うまく撮れませんでした。明るい場所でもう一度');
    saveSamples(memberId, [...getSamples(memberId), ...got]);
    return got.length;
  }

  // ---------- 認識 ----------
  let scanning = false;
  /**
   * @returns {Promise<{id:string,d:number}|null>}
   */
  async function identify(video, memberIds, onStatus = () => {}) {
    if (scanning) return null;
    if (!memberIds.some((id) => sampleCount(id) > 0)) return null;
    scanning = true;
    let fa;
    try {
      onStatus('loading');
      fa = await ensureLoaded();
      await startCamera(video);
      onStatus('scanning');
      const end = Date.now() + opts.scanTimeoutMs;
      let streak = { id: null, n: 0 };
      while (Date.now() < end) {
        const r = await describe(fa, video);
        if (r) {
          const m = match(r.descriptor, memberIds);
          if (m) {
            streak = streak.id === m.id ? { id: m.id, n: streak.n + 1 } : { id: m.id, n: 1 };
            if (streak.n >= opts.confirmFrames) return m;
          } else {
            streak = { id: null, n: 0 };
            onStatus('unsure');
          }
        }
        await new Promise((r) => setTimeout(r, opts.intervalMs));
      }
      return null;
    } finally {
      stopCamera(video);
      scanning = false;
    }
  }

  window.FaceID = {
    opts,
    supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    preload: () => ensureLoaded(),
    enroll,
    identify,
    sampleCount,
    clear,
    clearAll,
    isScanning: () => scanning,
  };
})();
