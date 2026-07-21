/* VN.summarizer — 로컬(오프라인) 요약/주요 주제/다음 할 일/키워드 + Gemini API 고급 모드 */
window.VN = window.VN || {};

VN.summarizer = (function () {

  /* ── 한국어/영어 토큰화 (조사 처리 간단 휴리스틱) ── */
  const STOPWORDS = new Set([
    // 한국어
    '그리고', '그래서', '하지만', '그런데', '그러면', '그러니까', '이제', '저희', '우리', '제가', '내가',
    '이거', '그거', '저거', '이것', '그것', '저것', '여기', '거기', '저기', '오늘', '내일', '어제',
    '있는', '없는', '있고', '하는', '해서', '하고', '하면', '됩니다', '입니다', '습니다', '있습니다',
    '같아요', '있어요', '해요', '네요', '지금', '정말', '진짜', '조금', '약간', '아마', '일단', '먼저',
    '다시', '계속', '바로', '그냥', '좀', '더', '또', '수', '것', '거', '때', '중', '등', '및', '점',
    '부분', '경우', '정도', '생각', '말씀', '얘기', '이야기', '번', '개', '분', '시', '월', '일', '년',
    // 영어
    'the', 'a', 'an', 'and', 'or', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'is',
    'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'i', 'we', 'you',
    'he', 'she', 'they', 'my', 'our', 'your', 'me', 'us', 'do', 'does', 'did', 'have', 'has', 'had',
    'will', 'would', 'can', 'could', 'should', 'not', 'no', 'yes', 'ok', 'okay', 'just', 'like',
    'about', 'as', 'if', 'then', 'than', 'there', 'here', 'now', 'get', 'go', 'going', 'let'
  ]);
  // 자주 쓰는 조사(긴 것 먼저)
  const JOSA = ['에서는', '으로는', '까지는', '부터는', '에게서', '으로써', '이라고', '라고', '에서', '에게', '한테',
    '으로', '까지', '부터', '처럼', '보다', '하고', '이나', '이며', '이랑', '랑', '과', '와', '은', '는',
    '이', '가', '을', '를', '의', '에', '로', '도', '만', '요'];

  /* 연결·종결 어미로 끝나는 토큰은 키워드/주제에서 제외 ("했는지", "모르겠으나" 등 — 제목 품질) */
  const ENDING_RE = /(는데|은데|으나|거나|는지|은지|을지|어서|아서|해서|니까|으니까|지만|다가|려고|고요|네요|거든요|습니다|입니다|다면)$/;

  function stripJosa(word) {
    if (!/[가-힣]$/.test(word)) return word;
    for (const j of JOSA) {
      if (word.length > j.length + 1 && word.endsWith(j)) return word.slice(0, word.length - j.length);
    }
    return word;
  }

  function tokenize(text) {
    const raw = String(text || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/).filter(w => w.length >= 2);
    return raw.map(stripJosa).filter(w =>
      w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !ENDING_RE.test(w));
  }

  function freqMap(tokens) {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }

  /* ── 키워드 ── */
  function keywords(text, topN) {
    const m = freqMap(tokenize(text));
    // 빈도 내림차순(빈도≥2가 자연히 우선). 동률은 stable sort로 등장 순서 유지 —
    // "긴 단어 우선"보다 실제 대화 흐름에 맞는 제목이 나온다.
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN || 8)
      .map(e => e[0]);
  }

  /* ── 추출 요약: 문장 점수 = 키워드 빈도 + 위치 + 길이 ── */
  function scoreSentences(sentences) {
    const all = sentences.map(s => tokenize(s.text));
    const globalFreq = freqMap(all.flat());
    const maxF = Math.max(1, ...globalFreq.values());
    return sentences.map((s, i) => {
      const toks = all[i];
      let kw = 0;
      for (const t of toks) kw += (globalFreq.get(t) || 0) / maxF;
      kw = toks.length ? kw / toks.length : 0;                    // 키워드 밀도
      const pos = (i < sentences.length * 0.15 || i >= sentences.length * 0.85) ? 0.15 : 0; // 위치 가산
      const len = Math.min(1, toks.length / 12) * 0.3;            // 너무 짧은 문장 감점
      return { idx: i, score: kw + pos + len, sentence: s };
    });
  }

  function summarize(sentences, maxN) {
    if (!sentences.length) return '';
    const scored = scoreSentences(sentences)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxN || 5)
      .sort((a, b) => a.idx - b.idx);
    return scored.map(s => '· ' + s.sentence.text.trim()).join('\n');
  }

  /* ── 주제 분할: 시간 간격 + 어휘 전환 → 구간별 소제목/요약 ── */
  function splitTopics(segments) {
    if (!segments.length) return [];
    const sections = [];
    let cur = [segments[0]];
    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1], seg = segments[i];
      const gap = (seg.start || 0) - (prev.end || prev.start || 0);
      let vocabShift = false;
      if (cur.length >= 4) {
        const curToks = new Set(tokenize(cur.slice(-4).map(s => s.text).join(' ')));
        const nextToks = tokenize(seg.text);
        const overlap = nextToks.filter(t => curToks.has(t)).length;
        vocabShift = nextToks.length >= 3 && overlap === 0;
      }
      if (gap > 30 || (vocabShift && cur.length >= 4) || cur.length >= 20) {
        sections.push(cur); cur = [seg];
      } else {
        cur.push(seg);
      }
    }
    sections.push(cur);
    return sections.map(sec => {
      const text = sec.map(s => s.text).join(' ');
      const kws = keywords(text, 2);
      return {
        title: kws.length ? kws.join(' · ') : '구간 ' + VN.util.fmtTime(sec[0].start),
        summary: summarize(sec, 1).replace(/^· /, ''),
        start: sec[0].start || 0
      };
    });
  }

  /* ── 다음 할 일: 한/영 패턴 ── */
  const TODO_PATTERNS = [
    /하기로/, /해야\s?(합니다|해요|겠|함|한다)?/, /해\s?주세요/, /해주세요/, /부탁드/, /부탁해/,
    /까지\s?(완료|제출|공유|전달|정리|마무리|보내|확인)/, /예정입니다|예정이에요|할\s?예정/,
    /확인해/, /공유해/, /전달해/, /보내\s?주/, /준비해/, /검토해/, /정리해/, /진행하겠/, /진행할게/,
    /챙겨/, /팔로업|follow\s?up/i,
    /\bTODO\b/i, /\bto-?do\b/i, /\baction\s?item/i, /\bneed(s)?\s+to\b/i, /\bshould\b/i,
    /\bwill\s+(send|share|check|prepare|review|follow)/i, /\bby\s+(monday|tuesday|wednesday|thursday|friday|next week|tomorrow|eod)\b/i
  ];

  function extractTodos(sentences) {
    const out = [];
    const seen = new Set();
    for (const s of sentences) {
      const t = s.text.trim();
      if (t.length < 5) continue;
      if (TODO_PATTERNS.some(p => p.test(t))) {
        const key = t.slice(0, 40);
        if (!seen.has(key)) { seen.add(key); out.push(t); }
      }
      if (out.length >= 10) break;
    }
    return out;
  }

  /* ── 스키마 정규화 (구형 저장분 하위 호환) ──
     구형: todos = ["문자열", …], decisions/openIssues 없음
     신형: todos = [{owner, task, due}, …] */
  function normalizeTodos(todos) {
    if (!Array.isArray(todos)) return [];
    return todos.map(t => {
      if (typeof t === 'string') return { owner: '', task: t.trim(), due: '' };
      if (t && typeof t === 'object') {
        return {
          owner: String(t.owner == null ? '' : t.owner).trim(),
          task: String(t.task == null ? '' : t.task).trim(),
          due: String(t.due == null ? '' : t.due).trim()
        };
      }
      return { owner: '', task: '', due: '' };
    }).filter(t => t.task);
  }

  function strList(arr) {
    return Array.isArray(arr) ? arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean) : [];
  }

  function normalizeSummary(sum) {
    if (!sum || typeof sum !== 'object') return sum;
    return Object.assign({}, sum, {
      summary: String(sum.summary || ''),
      decisions: strList(sum.decisions),
      openIssues: strList(sum.openIssues),
      todos: normalizeTodos(sum.todos),
      topics: Array.isArray(sum.topics) ? sum.topics.map(t => ({
        title: String((t && t.title) || ''),
        summary: String((t && t.summary) || ''),
        start: Number(t && t.start) || 0
      })) : [],
      keywords: strList(sum.keywords)
    });
  }

  /* 담당자별 그룹 (담당자 없으면 '미지정').
     items[].index는 정규화된 todos 배열에서의 위치 — 편집 UI가 원본을 되짚는 데 쓴다. */
  function groupTodosByOwner(todos) {
    const groups = [];
    const byOwner = new Map();
    const list = normalizeTodos(todos);
    list.forEach((t, i) => {
      const key = t.owner || '미지정';
      if (!byOwner.has(key)) { byOwner.set(key, []); groups.push({ owner: key, items: byOwner.get(key) }); }
      byOwner.get(key).push(Object.assign({ index: i }, t));
    });
    // '미지정'은 항상 마지막
    return groups.sort((a, b) => (a.owner === '미지정' ? 1 : 0) - (b.owner === '미지정' ? 1 : 0));
  }

  /* ── 로컬 실행 ── */
  function runLocal(note) {
    const segs = (note.segments || []).filter(s => s.text && s.text.trim());
    const sentences = segs.map(s => ({ text: s.text, start: s.start, end: s.end }));
    const fullText = sentences.map(s => s.text).join(' ');
    return {
      mode: 'local',
      summary: summarize(sentences, 5) || '(요약할 텍스트가 없습니다)',
      decisions: [],
      openIssues: [],
      topics: splitTopics(segs),
      todos: extractTodos(sentences).map(task => ({ owner: '', task, due: '' })),
      keywords: keywords(fullText, 8)
    };
  }

  /* ── Gemini API 고급 모드 ── */
  /* 무료 티어에서 실제로 응답하는 모델만 노출한다.
     (2.5 계열은 신규 사용자에게 404, pro 계열은 무료 티어 쿼터 0으로 429) */
  const SUMMARY_MODELS = ['gemini-3.5-flash', 'gemini-flash-latest'];
  const DEFAULT_MODEL = 'gemini-3.5-flash';
  /* 오디오 전사는 비용이 커서 요약 모델 선택과 무관하게 flash 고정 */
  const TRANSCRIBE_MODEL = DEFAULT_MODEL;

  function pickModel(model) {
    return SUMMARY_MODELS.indexOf(model) !== -1 ? model : DEFAULT_MODEL;
  }

  /* 요약 품질 모드 — 'quality'(사고 켬, 기본) / 'speed'(사고 끔) */
  const QUALITY_MODES = ['quality', 'speed'];
  const DEFAULT_QUALITY = 'quality';

  function pickQuality(q) {
    return QUALITY_MODES.indexOf(q) !== -1 ? q : DEFAULT_QUALITY;
  }

  /* quality='quality'  → thinkingConfig를 생략한다. 모델 기본값이 동적 사고이며,
                          실호출에서 usageMetadata.thoughtsTokenCount > 0으로 확인됨.
     quality='speed'    → thinkingBudget:0으로 사고를 꺼 응답을 빠르게 한다.
     pro 계열은 thinking을 끌 수 없어 thinkingBudget:0을 보내면 요청이 거부되므로 제외.
     quality 미지정(오디오 전사 등)은 기존대로 속도 우선. */
  function buildGenerationConfig(model, temperature, quality) {
    const cfg = { responseMimeType: 'application/json', temperature: temperature };
    if (quality !== 'quality' && String(model).indexOf('pro') === -1) cfg.thinkingConfig = { thinkingBudget: 0 };
    return cfg;
  }

  async function runGemini(note, apiKey, model, quality, onRetry) {
    model = pickModel(model);
    quality = pickQuality(quality);
    const segs = (note.segments || []).filter(s => s.text && s.text.trim());
    if (!segs.length) throw new Error('요약할 텍스트가 없습니다.');
    const speakers = note.speakers || [];
    const nameOf = (i) => (speakers[i] && speakers[i].name) || ('참석자 ' + ((i || 0) + 1));
    const transcript = segs.map(s => {
      return '[' + VN.util.fmtTime(s.start) + '] ' + nameOf(s.speaker) + ': ' + s.text;
    }).join('\n').slice(0, 100000);
    const attendees = [...new Set(segs.map(s => s.speaker || 0))].sort((a, b) => a - b).map(nameOf);

    const prompt = '다음은 회의 녹음의 전사 텍스트입니다. 회의록으로 정리해 아래 JSON 형식으로만 답하세요(다른 텍스트 금지).\n' +
      '{"summary":"핵심 3~5문장","decisions":["결정 사항"],"openIssues":["미결 안건"],' +
      '"todos":[{"owner":"담당자","task":"할 일","due":"기한"}],' +
      '"topics":[{"title":"소제목","summary":"한 문장 요약","start":초(number)}],"keywords":["키워드"]}\n' +
      '규칙:\n' +
      '- summary: 회의 전체 흐름이 드러나는 핵심 3~5문장.\n' +
      '- decisions: 회의에서 확정된 결정 사항만. 확정되지 않은 내용은 넣지 마세요.\n' +
      '- openIssues: 결론 없이 남은 논의나 보류된 안건.\n' +
      '- todos의 owner는 반드시 다음 참석자 목록에 있는 이름 중 하나만 사용하세요: [' + attendees.join(', ') + ']. ' +
      '대화에서 담당자가 명확하지 않으면 빈 문자열("")로 두세요. 추측으로 사람을 지정하지 마세요.\n' +
      '- todos의 due는 대화에 나온 기한 표현을 그대로 쓰고(예: "이번 주 금요일", "8월 15일"), 언급이 없으면 빈 문자열("").\n' +
      '- topics의 start는 해당 구간이 시작되는 초 단위 숫자입니다. keywords는 5~8개.\n' +
      '- 한국어로 답하되, 회의에서 실제로 사용된 용어와 고유명사는 그대로 유지하세요.\n\n' +
      '--- 전사 ---\n' + transcript;

    /* 무료 등급은 혼잡할 때 503(UNAVAILABLE)/429를 자주 돌려준다. 한 번 실패했다고
       오프라인 요약으로 내려가면 품질이 크게 떨어지므로 잠시 기다렸다 다시 시도한다. */
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: buildGenerationConfig(model, 0.3, quality)
    });
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
    const waits = [3000, 8000, 15000];
    const ATTEMPT_TIMEOUT = 45000; // 응답이 없어도 버튼이 영원히 돌지 않도록 시도마다 상한을 둔다
    let resp, lastMsg = '';
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT);
      let timedOut = false;
      try {
        resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
          { method: 'POST', headers: headers, body: body, signal: ctrl.signal });
      } catch (e) {
        if (e && e.name === 'AbortError') { timedOut = true; lastMsg = '응답이 45초 안에 오지 않았습니다.'; }
        else { lastMsg = '네트워크 오류: ' + ((e && e.message) || e); }
      } finally { clearTimeout(timer); }
      if (!timedOut && resp && resp.ok) break;
      if (!timedOut && resp) {
        lastMsg = 'API 오류 (' + resp.status + ')';
        try { const j = await resp.json(); if (j.error && j.error.message) lastMsg += ': ' + j.error.message; } catch (e) { /* ignore */ }
        if (!(resp.status === 429 || resp.status >= 500)) throw new Error(lastMsg);
      }
      if (attempt >= waits.length) throw new Error(lastMsg);
      if (typeof onRetry === 'function') onRetry(attempt + 1, waits.length + 1);
      await new Promise(r => setTimeout(r, waits[attempt]));
    }
    const data = await resp.json();
    let text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
    text = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const jsonStart = text.indexOf('{');
    if (jsonStart > 0) text = text.slice(jsonStart);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('API 응답을 해석하지 못했습니다.'); }
    return normalizeSummary(Object.assign({ mode: 'gemini', model: model }, parsed));
  }

  /* ── Gemini 오디오 전사: Blob(≤18MB)을 inlineData로 보내 화자 라벨 세그먼트 획득
       (오디오 전사는 비용이 커서 요약 모델 선택과 무관하게 TRANSCRIBE_MODEL 고정) ── */
  async function transcribeAudioGemini(blob, opts) {
    opts = opts || {};
    const apiKey = await VN.db.getSetting('geminiApiKey', '');
    if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다. (설정 → 고급 모드)');
    if (!(blob instanceof Blob)) throw new Error('오디오가 없습니다.');
    if (blob.size * 4 / 3 > 18 * 1024 * 1024) {
      throw new Error('오디오가 18MB를 초과하여 Gemini 변환을 사용할 수 없습니다. (분할 미지원 — Whisper 변환을 사용하세요)');
    }
    const b64 = await VN.util.blobToBase64(blob);
    const langLabel = { 'ko-KR': '한국어', 'en-US': '영어', 'ja-JP': '일본어', 'zh-CN': '중국어' }[opts.language] || '들리는 언어';
    const prompt = '첨부된 오디오 전체를 ' + langLabel + '로 전사하세요. ' +
      '각 발화를 {"start": 발화 시작 시각(초, number), "speaker": "참석자1"|"참석자2"|… (목소리로 화자 추정), "text": "발화 내용"} ' +
      '객체로 하는 JSON 배열만 출력하세요. 다른 텍스트 금지. 무음 구간은 건너뛰세요.';
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + TRANSCRIBE_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: blob.type || 'audio/webm', data: b64 } }
          ]
        }],
        generationConfig: buildGenerationConfig(TRANSCRIBE_MODEL, 0.2, 'speed')
      })
    });
    if (!resp.ok) {
      let msg = 'Gemini API 오류 (' + resp.status + ')';
      try { const j = await resp.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    const data = await resp.json();
    let text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
    text = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const jsonStart = text.indexOf('[');
    if (jsonStart > 0) text = text.slice(jsonStart);
    let arr;
    try { arr = JSON.parse(text); } catch (e) { throw new Error('Gemini 전사 응답을 해석하지 못했습니다.'); }
    if (!Array.isArray(arr)) throw new Error('Gemini 전사 응답 형식이 올바르지 않습니다.');
    return arr.map(x => ({
      start: Math.max(0, Number(x.start) || 0),
      speakerLabel: String(x.speaker || '참석자1').trim() || '참석자1',
      text: String(x.text || '').trim()
    })).filter(x => x.text);
  }

  /* ── 진입점: API 키가 있으면 Gemini, 실패 시 로컬 폴백.
       onRetry(n, total)는 재시도 진행을 UI(버튼 텍스트 등)에 알린다. ── */
  async function run(note, onRetry) {
    const apiKey = await VN.db.getSetting('geminiApiKey', '');
    if (apiKey) {
      try {
        const model = pickModel(await VN.db.getSetting('geminiModel', DEFAULT_MODEL));
        const quality = pickQuality(await VN.db.getSetting('geminiQuality', DEFAULT_QUALITY));
        return await runGemini(note, apiKey, model, quality, onRetry);
      } catch (e) {
        const local = runLocal(note);
        local.fallbackReason = 'Gemini API 실패로 기본 모드로 생성했습니다: ' + (e.message || e);
        return local;
      }
    }
    return runLocal(note);
  }

  return {
    run, runLocal, runGemini, transcribeAudioGemini,
    summarize, splitTopics, extractTodos, keywords, tokenize,
    normalizeSummary, normalizeTodos, groupTodosByOwner,
    buildGenerationConfig,
    SUMMARY_MODELS, DEFAULT_MODEL, TRANSCRIBE_MODEL,
    QUALITY_MODES, DEFAULT_QUALITY, pickQuality
  };
})();
