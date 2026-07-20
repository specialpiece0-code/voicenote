/* VN.recorder — MediaRecorder 녹음 + AnalyserNode 실시간 파형
   일시정지 구간을 제외한 경과 시간(currentTime)을 제공한다. */
window.VN = window.VN || {};

VN.recorder = (function () {
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

  let state = 'idle'; // idle | recording | paused
  let mediaRecorder = null;
  let stream = null;
  let chunks = [];
  let mimeType = '';

  // 경과 시간(일시정지 제외)
  let accumMs = 0;        // 일시정지 이전까지 누적
  let runStartMs = 0;     // 현재 구간 시작 시각(performance.now)

  // 파형
  let audioCtx = null;
  let analyser = null;
  let waveCanvas = null;
  let rafId = null;
  let levelSamples = [];  // 노트 저장용 파형 피크 (약 4Hz 샘플)
  let lastLevelAt = 0;

  function currentTime() {
    let ms = accumMs;
    if (state === 'recording') ms += performance.now() - runStartMs;
    return ms / 1000;
  }

  function pickMime() {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''];
    for (const c of cands) {
      if (!c) return '';
      try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (e) { /* ignore */ }
    }
    return '';
  }

  function drawLoop() {
    if (!analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    // 레벨(RMS) 계산
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (state === 'recording' && now - lastLevelAt > 250) {
      levelSamples.push(Math.min(1, rms * 3));
      lastLevelAt = now;
    }
    if (waveCanvas) {
      const ctx = waveCanvas.getContext('2d');
      const W = waveCanvas.width, H = waveCanvas.height;
      ctx.clearRect(0, 0, W, H);
      const style = getComputedStyle(document.documentElement);
      ctx.strokeStyle = style.getPropertyValue('--green').trim() || '#03C75A';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(buf.length / W));
      for (let x = 0; x < W; x++) {
        const v = (buf[Math.min(buf.length - 1, x * step)] - 128) / 128;
        const y = H / 2 + v * (H / 2 - 4);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    rafId = requestAnimationFrame(drawLoop);
  }

  async function start(opts) {
    opts = opts || {};
    if (!supported) throw new Error('이 브라우저는 녹음(MediaRecorder)을 지원하지 않습니다.');
    if (state !== 'idle') throw new Error('이미 녹음 중입니다.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mimeType = pickMime();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    levelSamples = [];
    accumMs = 0;
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.start(1000); // 1초 단위 청크

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);

    waveCanvas = opts.canvas || null;
    runStartMs = performance.now();
    state = 'recording';
    drawLoop();
  }

  function pause() {
    if (state !== 'recording') return;
    accumMs += performance.now() - runStartMs;
    try { mediaRecorder.pause(); } catch (e) { /* ignore */ }
    state = 'paused';
  }

  function resume() {
    if (state !== 'paused') return;
    try { mediaRecorder.resume(); } catch (e) { /* ignore */ }
    runStartMs = performance.now();
    state = 'recording';
  }

  function teardown() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } }
    audioCtx = null; analyser = null; waveCanvas = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); }
    stream = null;
    state = 'idle';
  }

  /* 중지 → {blob, duration(초, 일시정지 제외), mimeType, waveform} */
  function stop() {
    return new Promise((res, rej) => {
      if (state === 'idle' || !mediaRecorder) return rej(new Error('녹음 중이 아닙니다.'));
      if (state === 'recording') accumMs += performance.now() - runStartMs;
      const duration = accumMs / 1000;
      const wf = levelSamples.slice();
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        teardown();
        res({ blob, duration, mimeType: mimeType || 'audio/webm', waveform: wf });
      };
      try { mediaRecorder.stop(); } catch (e) { teardown(); rej(e); }
    });
  }

  function cancel() {
    if (state === 'idle') return;
    try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (e) { /* ignore */ }
    chunks = [];
    teardown();
  }

  return {
    supported,
    get state() { return state; },
    currentTime, start, pause, resume, stop, cancel
  };
})();
