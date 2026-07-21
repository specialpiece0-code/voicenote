/* VN.recorder — MediaRecorder 녹음 + AnalyserNode 실시간 파형 + 크래시 세이프
   경과 시간은 Date.now() 절대시각 차(일시정지 구간 차감)로 계산한다 — 탭 숨김 중에도 정확.
   setInterval/rAF는 UI 갱신 전용이며 데이터에 관여하지 않는다.
   크래시 세이프: 1초 timeslice 청크를 5초마다 메타(세그먼트·메모·북마크·경과시간)와 함께
   IndexedDB recChunks store에 flush → 앱 시작 시 잔존 세션 복구 가능. */
window.VN = window.VN || {};

VN.recorder = (function () {
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const FLUSH_MS = 5000;

  let state = 'idle'; // idle | recording | paused
  let mediaRecorder = null;
  let stream = null;
  let chunks = [];
  let mimeType = '';

  // 경과 시간(일시정지 제외) — Date.now() 기반 절대시각 차
  let accumMs = 0;        // 일시정지 이전까지 누적
  let runStartMs = 0;     // 현재 구간 시작 시각(Date.now)

  // 파형
  let audioCtx = null;
  let analyser = null;
  let waveCanvas = null;
  let rafId = null;
  let levelSamples = [];  // 노트 저장용 파형 피크
  let levelTimer = null;  // 레벨 샘플링은 rAF가 아니라 interval (탭 숨김 시 rAF 정지 대비)

  // 수음 보강 체인의 출력 스트림 (teardown에서 트랙 정지)
  let procStream = null;

  // 크래시 세이프 flush
  let persist = null;       // { getMeta() } — ui가 세그먼트·메모·북마크 스냅샷 제공
  let pendingChunks = [];   // 아직 IndexedDB에 저장 안 된 청크
  let chunkSeq = 0;
  let flushTimer = null;
  let flushing = false;

  function currentTime() {
    let ms = accumMs;
    if (state === 'recording') ms += Date.now() - runStartMs;
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

  /* 레벨(RMS) 샘플링 — 데이터용이므로 rAF가 아닌 interval로 수행 */
  function sampleLevel() {
    if (!analyser || state !== 'recording') return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    levelSamples.push(Math.min(1, Math.sqrt(sum / buf.length) * 3));
  }

  /* 파형 그리기 — UI 전용. 탭 숨김 시 rAF가 자동 정지되고 복귀 시 재개된다. */
  function drawLoop() {
    if (!analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
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

  /* 5초 주기: 새 청크 + 메타 스냅샷을 recChunks store에 저장 */
  async function flush() {
    if (flushing || !persist) return;
    flushing = true;
    const toSave = pendingChunks.splice(0, pendingChunks.length);
    try {
      for (const c of toSave) {
        await VN.db.put('recChunks', { id: 'c' + String(c.idx).padStart(6, '0'), idx: c.idx, blob: c.blob });
      }
      const meta = (persist.getMeta && persist.getMeta()) || {};
      await VN.db.put('recChunks', Object.assign({}, meta, {
        id: 'meta',
        elapsed: currentTime(),
        mimeType: mimeType || 'audio/webm',
        updatedAt: Date.now()
      }));
    } catch (e) {
      // 저장 실패 → 다음 주기에 재시도
      pendingChunks = toSave.concat(pendingChunks);
    }
    flushing = false;
  }

  /* 복구용: recChunks 레코드 배열 → 하나의 Blob (webm 단순 연결) */
  function assembleChunks(records) {
    const sorted = (records || []).filter(r => r && r.blob).slice().sort((a, b) => (a.idx || 0) - (b.idx || 0));
    const type = (sorted[0] && sorted[0].blob.type) || 'audio/webm';
    return new Blob(sorted.map(r => r.blob), { type });
  }

  async function start(opts) {
    opts = opts || {};
    if (!supported) throw new Error('이 브라우저는 녹음(MediaRecorder)을 지원하지 않습니다.');
    if (state !== 'idle') throw new Error('이미 녹음 중입니다.');
    // 에코 제거(같은 기기가 재생 중인 다른 앱 소리 상쇄) + 노이즈 억제 + 자동 게인
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    // 수음 보강: 컴프레서(+게인) 체인을 거친 스트림을 녹음해 작은 목소리를 키운다.
    // 체인 구성이 실패하면 원본 마이크 스트림으로 폴백. 크래시 세이프 청크 로직은 동일.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try { audioCtx.resume(); } catch (e) { /* ignore */ }
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    let recStream = stream;
    try {
      const src = audioCtx.createMediaStreamSource(stream);
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -45;  // 작은 소리부터 압축 시작 → 다이내믹 레인지 축소
      comp.knee.value = 30;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      const gain = audioCtx.createGain();
      gain.gain.value = 1.5;       // 압축으로 낮아진 평균 레벨 보상 + 증폭
      const dest = audioCtx.createMediaStreamDestination();
      src.connect(comp);
      comp.connect(gain);
      gain.connect(dest);
      gain.connect(analyser);      // 파형·레벨 샘플링도 처리된 신호 기준
      procStream = dest.stream;
      recStream = procStream;
    } catch (e) {
      // 폴백: 원본 스트림 녹음 + 원본에서 파형만 추출
      try { audioCtx.createMediaStreamSource(stream).connect(analyser); } catch (e2) { analyser = null; }
    }
    mimeType = pickMime();
    mediaRecorder = new MediaRecorder(recStream, mimeType ? { mimeType } : undefined);
    chunks = [];
    levelSamples = [];
    accumMs = 0;
    persist = opts.persist || null;
    pendingChunks = [];
    chunkSeq = 0;
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        if (persist) pendingChunks.push({ idx: chunkSeq++, blob: e.data });
      }
    };
    mediaRecorder.start(1000); // 1초 timeslice 청크

    if (persist) {
      try { await VN.db.clear('recChunks'); } catch (e) { /* ignore */ }
      flushTimer = setInterval(flush, FLUSH_MS);
    }

    levelTimer = setInterval(sampleLevel, 250);

    waveCanvas = opts.canvas || null;
    runStartMs = Date.now();
    state = 'recording';
    drawLoop();
  }

  function pause() {
    if (state !== 'recording') return;
    accumMs += Date.now() - runStartMs;
    try { mediaRecorder.pause(); } catch (e) { /* ignore */ }
    state = 'paused';
  }

  function resume() {
    if (state !== 'paused') return;
    try { mediaRecorder.resume(); } catch (e) { /* ignore */ }
    runStartMs = Date.now();
    state = 'recording';
  }

  function teardown() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    persist = null;
    pendingChunks = [];
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } }
    audioCtx = null; analyser = null; waveCanvas = null;
    if (procStream) { try { procStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ } }
    procStream = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); }
    stream = null;
    state = 'idle';
  }

  /* 중지 → {blob, duration(초, 일시정지 제외), mimeType, waveform}
     recChunks 정리는 노트 저장 성공 후 호출자가 VN.db.clear('recChunks')로 수행한다. */
  function stop() {
    return new Promise((res, rej) => {
      if (state === 'idle' || !mediaRecorder) return rej(new Error('녹음 중이 아닙니다.'));
      if (state === 'recording') accumMs += Date.now() - runStartMs;
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
    VN.db.clear('recChunks').catch(() => { /* ignore */ });
  }

  /* 녹음 화면 재진입 시 새 캔버스로 파형 출력을 옮긴다 (세션은 그대로 유지) */
  function bindCanvas(canvas) { waveCanvas = canvas || null; }

  return {
    supported,
    get state() { return state; },
    currentTime, start, pause, resume, stop, cancel, assembleChunks, bindCanvas
  };
})();
