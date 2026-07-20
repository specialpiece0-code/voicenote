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
    return raw.map(stripJosa).filter(w => w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  }

  function freqMap(tokens) {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }

  /* ── 키워드 ── */
  function keywords(text, topN) {
    const m = freqMap(tokenize(text));
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
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

  /* ── 로컬 실행 ── */
  function runLocal(note) {
    const segs = (note.segments || []).filter(s => s.text && s.text.trim());
    const sentences = segs.map(s => ({ text: s.text, start: s.start, end: s.end }));
    const fullText = sentences.map(s => s.text).join(' ');
    return {
      mode: 'local',
      summary: summarize(sentences, 5) || '(요약할 텍스트가 없습니다)',
      topics: splitTopics(segs),
      todos: extractTodos(sentences),
      keywords: keywords(fullText, 8)
    };
  }

  /* ── Gemini API 고급 모드 ── */
  async function runGemini(note, apiKey) {
    const segs = (note.segments || []).filter(s => s.text && s.text.trim());
    if (!segs.length) throw new Error('요약할 텍스트가 없습니다.');
    const speakers = note.speakers || [];
    const transcript = segs.map(s => {
      const name = (speakers[s.speaker] && speakers[s.speaker].name) || ('참석자 ' + ((s.speaker || 0) + 1));
      return '[' + VN.util.fmtTime(s.start) + '] ' + name + ': ' + s.text;
    }).join('\n').slice(0, 100000);

    const prompt = '다음은 음성 녹음의 전사 텍스트입니다. 아래 JSON 형식으로만 답하세요(다른 텍스트 금지).\n' +
      '{"summary":"3~5문장 요약","topics":[{"title":"소제목","summary":"한 문장 요약","start":초(number)}],' +
      '"todos":["할 일 항목"],"keywords":["키워드"]}\n' +
      'topics의 start는 해당 구간이 시작되는 초 단위 숫자입니다. keywords는 5~8개.\n\n' +
      '--- 전사 ---\n' + transcript;

    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.3,
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });
    if (!resp.ok) {
      let msg = 'API 오류 (' + resp.status + ')';
      try { const j = await resp.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) { /* ignore */ }
      throw new Error(msg);
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
    return {
      mode: 'gemini',
      summary: String(parsed.summary || ''),
      topics: Array.isArray(parsed.topics) ? parsed.topics.map(t => ({
        title: String(t.title || ''), summary: String(t.summary || ''), start: Number(t.start) || 0
      })) : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos.map(String) : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : []
    };
  }

  /* ── 진입점: API 키가 있으면 Gemini, 실패 시 로컬 폴백 ── */
  async function run(note) {
    const apiKey = await VN.db.getSetting('geminiApiKey', '');
    if (apiKey) {
      try {
        return await runGemini(note, apiKey);
      } catch (e) {
        const local = runLocal(note);
        local.fallbackReason = 'Gemini API 실패로 기본 모드로 생성했습니다: ' + (e.message || e);
        return local;
      }
    }
    return runLocal(note);
  }

  return { run, runLocal, runGemini, summarize, splitTopics, extractTodos, keywords, tokenize };
})();
