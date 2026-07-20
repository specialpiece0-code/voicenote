/* VN.diarize — 자동 화자 분리 전사
   녹음된 오디오 Blob을 외부 STT API(Deepgram / AssemblyAI)로 보내
   화자가 분리된 전사본을 받아온다. 브라우저에서 직접 호출한다(프록시 없음).

   VN.diarize.transcribe(blob, { provider, language, onProgress })
     → { segments: [{start, end, speaker, text}], speakerCount, provider }
       start/end = 초, speaker = 0부터의 정수, text = 문자열 */
window.VN = window.VN || {};

VN.diarize = (function () {
  const PROVIDERS = ['deepgram', 'assemblyai'];
  const KEY_SETTING = {
    deepgram: 'deepgramApiKey',
    assemblyai: 'assemblyaiApiKey'
  };

  const GAP_SPLIT_SEC = 2;          // 같은 화자라도 이 간격을 넘으면 세그먼트 분리
  const BIG_UPLOAD_BYTES = 100 * 1024 * 1024;
  const DEEPGRAM_TIMEOUT_MS = 10 * 60 * 1000;
  const AAI_STEP_TIMEOUT_MS = 2 * 60 * 1000;
  const AAI_POLL_INTERVAL_MS = 3000;
  const AAI_POLL_TIMEOUT_MS = 10 * 60 * 1000;

  /* ── 순수 함수 ── */

  /* 'ko-KR' → 'ko'. 이미 'ko' 형태면 그대로. */
  function langCode(lang) {
    if (!lang || typeof lang !== 'string') return 'ko';
    const base = lang.trim().split(/[-_]/)[0].toLowerCase();
    return base || 'ko';
  }

  /* Deepgram words[] → 세그먼트 배열.
     같은 speaker 연속 구간을 병합하되, 단어 사이 간격이 2초를 넘으면 분리한다.
     speaker 값은 여기서는 원본 그대로 두고 normalizeSpeakers가 재매핑한다. */
  function mergeWords(words) {
    const segs = [];
    if (!Array.isArray(words)) return segs;
    let cur = null;
    let prevEnd = null;

    for (const w of words) {
      if (!w) continue;
      const text = (w.punctuated_word != null ? w.punctuated_word : w.word);
      if (text == null || text === '') continue;
      const start = Number(w.start) || 0;
      const end = Number(w.end) || start;
      const speaker = (w.speaker != null ? w.speaker : 0);

      const sameSpeaker = cur && cur.speaker === speaker;
      const gapOk = prevEnd == null || (start - prevEnd) <= GAP_SPLIT_SEC;

      if (sameSpeaker && gapOk) {
        cur.text += ' ' + text;
        cur.end = end;
      } else {
        cur = { start, end, speaker, text: String(text) };
        segs.push(cur);
      }
      prevEnd = end;
    }
    return segs;
  }

  /* 세그먼트의 speaker 값(정수든 'A'든)을 등장 순서대로 0..N-1 정수로 재매핑.
     새 배열을 반환한다. */
  function normalizeSpeakers(segs) {
    if (!Array.isArray(segs)) return [];
    const map = new Map();
    return segs.map((s) => {
      const raw = s && s.speaker != null ? s.speaker : 0;
      const key = String(raw);
      if (!map.has(key)) map.set(key, map.size);
      return {
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        speaker: map.get(key),
        text: s.text != null ? String(s.text) : ''
      };
    });
  }

  function countSpeakers(segs) {
    const set = new Set();
    for (const s of segs) set.add(s.speaker);
    return set.size;
  }

  /* ── 공통 유틸 ── */

  function noop() {}

  function progressOf(opts) {
    return (opts && typeof opts.onProgress === 'function') ? opts.onProgress : noop;
  }

  /* HTTP 상태 → 한국어 안내 */
  function httpMessage(status, bodyText) {
    if (status === 401 || status === 403) return 'API 키가 올바르지 않습니다.';
    if (status === 429) return '요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
    let detail = '';
    if (bodyText) {
      const t = String(bodyText).trim().slice(0, 200);
      if (t) detail = ' (' + t + ')';
    }
    return '전사 서버 오류가 발생했습니다. (HTTP ' + status + ')' + detail;
  }

  async function readBody(res) {
    try { return await res.text(); } catch (e) { return ''; }
  }

  /* fetch 래퍼: AbortController 타임아웃 + TypeError/중단 원인 특정 */
  async function request(url, init, timeoutMs, label) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
    } catch (e) {
      if (timedOut) {
        throw new Error((label || '요청') + ' 시간이 초과되었습니다. 파일이 크거나 네트워크가 느릴 수 있습니다.');
      }
      if (e && e.name === 'AbortError') {
        throw new Error((label || '요청') + '이(가) 중단되었습니다.');
      }
      if (e instanceof TypeError) {
        throw new Error('네트워크 오류 또는 브라우저에서 직접 호출이 차단되었습니다. 인터넷 연결과 확장 프로그램(광고 차단 등)을 확인해 주세요.');
      }
      throw new Error((label || '요청') + '에 실패했습니다: ' + ((e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
  }

  async function getKey(provider) {
    const setting = KEY_SETTING[provider];
    if (!setting) return '';
    let v = '';
    try {
      v = await VN.db.getSetting(setting, '');
    } catch (e) {
      v = '';
    }
    return (v || '').trim();
  }

  async function isConfigured(provider) {
    return !!(await getKey(provider));
  }

  function warnIfLarge(blob, onProgress) {
    if (blob && blob.size > BIG_UPLOAD_BYTES) {
      onProgress(0, '파일이 큽니다(' + Math.round(blob.size / 1048576) + 'MB). 업로드에 시간이 걸릴 수 있습니다.');
    }
  }

  /* ── Deepgram ── */

  async function transcribeDeepgram(blob, opts, key) {
    const onProgress = progressOf(opts);
    const lang = langCode(opts.language);
    const url = 'https://api.deepgram.com/v1/listen'
      + '?model=nova-2&diarize=true&punctuate=true&smart_format=true&language=' + encodeURIComponent(lang);

    warnIfLarge(blob, onProgress);
    onProgress(0.05, '오디오 업로드 중…');

    const res = await request(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + key,
        'Content-Type': (blob && blob.type) || 'audio/webm'
      },
      body: blob
    }, DEEPGRAM_TIMEOUT_MS, '전사 요청');

    if (!res.ok) {
      throw new Error(httpMessage(res.status, await readBody(res)));
    }

    onProgress(0.8, '결과 정리 중…');
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('전사 결과를 해석하지 못했습니다.');
    }

    const alt = data && data.results && data.results.channels
      && data.results.channels[0] && data.results.channels[0].alternatives
      && data.results.channels[0].alternatives[0];
    const words = (alt && alt.words) || [];
    if (!words.length) throw new Error('인식된 음성이 없습니다.');

    const segments = normalizeSpeakers(mergeWords(words));
    if (!segments.length) throw new Error('인식된 음성이 없습니다.');

    onProgress(1, '완료');
    return { segments, speakerCount: countSpeakers(segments), provider: 'deepgram' };
  }

  /* ── AssemblyAI ── */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function transcribeAssemblyAI(blob, opts, key) {
    const onProgress = progressOf(opts);
    const lang = langCode(opts.language);

    warnIfLarge(blob, onProgress);

    /* 1) 업로드 */
    onProgress(0.05, '오디오 업로드 중…');
    const upRes = await request('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { 'authorization': key },
      body: blob
    }, AAI_STEP_TIMEOUT_MS, '업로드');
    if (!upRes.ok) throw new Error(httpMessage(upRes.status, await readBody(upRes)));
    let upJson;
    try { upJson = await upRes.json(); } catch (e) { upJson = null; }
    const audioUrl = upJson && upJson.upload_url;
    if (!audioUrl) throw new Error('오디오 업로드에 실패했습니다.');

    /* 2) 전사 작업 생성 */
    onProgress(0.3, '전사 대기열에 등록 중…');
    const jobRes = await request('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        'authorization': key,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        speaker_labels: true,
        language_code: lang
      })
    }, AAI_STEP_TIMEOUT_MS, '전사 요청');
    if (!jobRes.ok) throw new Error(httpMessage(jobRes.status, await readBody(jobRes)));
    let jobJson;
    try { jobJson = await jobRes.json(); } catch (e) { jobJson = null; }
    const id = jobJson && jobJson.id;
    if (!id) throw new Error('전사 작업을 생성하지 못했습니다.');

    /* 3) 폴링 */
    const deadline = Date.now() + AAI_POLL_TIMEOUT_MS;
    let result = null;
    while (Date.now() < deadline) {
      await sleep(AAI_POLL_INTERVAL_MS);
      const pollRes = await request('https://api.assemblyai.com/v2/transcript/' + encodeURIComponent(id), {
        method: 'GET',
        headers: { 'authorization': key }
      }, AAI_STEP_TIMEOUT_MS, '진행 상황 확인');
      if (!pollRes.ok) throw new Error(httpMessage(pollRes.status, await readBody(pollRes)));
      let j;
      try { j = await pollRes.json(); } catch (e) { j = null; }
      if (!j) throw new Error('전사 결과를 해석하지 못했습니다.');

      if (j.status === 'completed') { result = j; break; }
      if (j.status === 'error') {
        throw new Error('전사에 실패했습니다: ' + (j.error || '알 수 없는 오류'));
      }
      if (j.status === 'processing') {
        onProgress(0.7, '처리 중…');
      } else {
        onProgress(0.45, '대기열에서 대기 중…');
      }
    }
    if (!result) throw new Error('전사 시간이 초과되었습니다(10분). 나중에 다시 시도해 주세요.');

    onProgress(0.9, '결과 정리 중…');
    const utterances = result.utterances || [];
    if (!utterances.length) throw new Error('인식된 음성이 없습니다.');

    const raw = utterances.map((u) => ({
      start: (Number(u.start) || 0) / 1000,
      end: (Number(u.end) || 0) / 1000,
      speaker: u.speaker != null ? u.speaker : 0,
      text: (u.text || '').trim()
    })).filter((s) => s.text);
    if (!raw.length) throw new Error('인식된 음성이 없습니다.');

    const segments = normalizeSpeakers(raw);
    onProgress(1, '완료');
    return { segments, speakerCount: countSpeakers(segments), provider: 'assemblyai' };
  }

  /* ── 진입점 ── */

  async function transcribe(blob, opts) {
    opts = opts || {};
    const provider = opts.provider || 'deepgram';
    if (PROVIDERS.indexOf(provider) === -1) {
      throw new Error('지원하지 않는 전사 제공자입니다: ' + provider);
    }
    if (!blob || !blob.size) {
      throw new Error('전사할 오디오가 없습니다.');
    }
    const key = await getKey(provider);
    if (!key) {
      const name = provider === 'deepgram' ? 'Deepgram' : 'AssemblyAI';
      throw new Error(name + ' API 키가 설정되어 있지 않습니다. 설정에서 키를 입력해 주세요.');
    }
    if (provider === 'deepgram') return transcribeDeepgram(blob, opts, key);
    return transcribeAssemblyAI(blob, opts, key);
  }

  return {
    providers: PROVIDERS,
    isConfigured,
    transcribe,
    _test: { mergeWords, normalizeSpeakers, langCode }
  };
})();
