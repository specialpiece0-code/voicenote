/* VN.whisper — (옵션) transformers.js Whisper 파일 변환
   CDN lazy load(dynamic import). 인터넷 필요. 실패 시 에러를 던져 UI가 안내한다. */
window.VN = window.VN || {};

VN.whisper = (function () {
  const CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
  const MODELS = {
    tiny: 'Xenova/whisper-tiny',
    base: 'Xenova/whisper-base'
  };
  let _lib = null;

  async function loadLib() {
    if (_lib) return _lib;
    if (!navigator.onLine) throw new Error('오프라인 상태입니다. Whisper 변환에는 인터넷 연결이 필요합니다.');
    try {
      _lib = await import(CDN);
    } catch (e) {
      throw new Error('Whisper 라이브러리(transformers.js)를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }
    return _lib;
  }

  /* Blob → 16kHz mono Float32Array */
  async function decodeTo16k(blob) {
    const arrayBuf = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const tmp = new AC();
    let audioBuf;
    try {
      audioBuf = await tmp.decodeAudioData(arrayBuf);
    } finally {
      try { tmp.close(); } catch (e) { /* ignore */ }
    }
    const targetRate = 16000;
    const length = Math.ceil(audioBuf.duration * targetRate);
    const off = new OfflineAudioContext(1, length, targetRate);
    const src = off.createBufferSource();
    src.buffer = audioBuf;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  const LANG_MAP = { 'ko-KR': 'korean', 'en-US': 'english', 'ja-JP': 'japanese', 'zh-CN': 'chinese' };

  /* transcribe(blob, {model:'tiny'|'base', language:'ko-KR', onProgress(pct,msg)})
     → [{start, end, text}] */
  async function transcribe(blob, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    onProgress(2, '라이브러리 로드 중…');
    const lib = await loadLib();
    lib.env.allowLocalModels = false;

    const modelId = MODELS[opts.model] || MODELS.tiny;
    onProgress(5, '모델 다운로드 중… (최초 1회, 수십 MB)');
    let transcriber;
    try {
      transcriber = await lib.pipeline('automatic-speech-recognition', modelId, {
        progress_callback: (p) => {
          if (p && p.status === 'progress' && p.total) {
            onProgress(5 + Math.round((p.loaded / p.total) * 55), '모델 다운로드 중… ' + (p.file || ''));
          }
        }
      });
    } catch (e) {
      throw new Error('Whisper 모델을 내려받지 못했습니다: ' + (e.message || e));
    }

    onProgress(62, '오디오 디코딩 중…');
    let audio;
    try {
      audio = await decodeTo16k(blob);
    } catch (e) {
      throw new Error('오디오를 디코딩하지 못했습니다. 지원되지 않는 형식일 수 있습니다.');
    }

    onProgress(70, '음성 인식 중…');
    let out;
    try {
      out = await transcriber(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
        language: LANG_MAP[opts.language] || undefined,
        task: 'transcribe'
      });
    } catch (e) {
      throw new Error('Whisper 인식에 실패했습니다: ' + (e.message || e));
    }
    onProgress(98, '결과 정리 중…');

    const segs = [];
    const chunks = (out && out.chunks) || [];
    if (chunks.length) {
      for (const c of chunks) {
        const ts = c.timestamp || [0, 0];
        const text = (c.text || '').trim();
        if (!text) continue;
        segs.push({ start: ts[0] || 0, end: ts[1] != null ? ts[1] : (ts[0] || 0) + 2, text });
      }
    } else if (out && out.text && out.text.trim()) {
      segs.push({ start: 0, end: audio.length / 16000, text: out.text.trim() });
    }
    onProgress(100, '완료');
    return segs;
  }

  return { transcribe, MODELS };
})();
