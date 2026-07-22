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

  /* 마인드맵 정규화 (순수 함수 — 셀프테스트 커버)
     깊이 최대 3(중심 주제 포함), 노드 총 30개 이내로 자른다. 없으면 null. */
  const MINDMAP_MAX_DEPTH = 2;   // 0(중심)~2 → 3단계
  const MINDMAP_MAX_NODES = 30;

  function normalizeMindmap(mm) {
    if (!mm || typeof mm !== 'object') return null;
    let count = 0;
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || count >= MINDMAP_MAX_NODES) return null;
      const topic = String(node.topic || '').trim();
      if (!topic) return null;
      count++;
      const out = { topic, children: [] };
      if (depth < MINDMAP_MAX_DEPTH && Array.isArray(node.children)) {
        for (const c of node.children) {
          const w = walk(c, depth + 1);
          if (w) out.children.push(w);
        }
      }
      return out;
    };
    return walk(mm, 0);
  }

  function normalizeSummary(sum) {
    if (!sum || typeof sum !== 'object') return sum;
    return Object.assign({}, sum, {
      summary: String(sum.summary || ''),
      /* 신형(적응형) 필드 — 구형 저장분에는 없으므로 기본값으로 채운다 */
      type: String(sum.type || ''),
      sections: Array.isArray(sum.sections) ? sum.sections.map(s => ({
        title: String((s && s.title) || ''),
        items: strList(s && s.items)
      })).filter(s => s.title || s.items.length) : [],
      mindmap: normalizeMindmap(sum.mindmap),
      /* 기존 필드 (구형·신형 공통) */
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

  /* ── 마인드맵 가로 트리 레이아웃 (순수 함수 — 셀프테스트 커버)
     깊이 → x 열, 리프를 세로로 쌓고 부모는 자식 가운데에 배치.
     노드 텍스트는 최대 2줄로 줄바꿈, 넘치면 말줄임. ── */
  function mindmapLayout(root, opts) {
    opts = opts || {};
    const CHAR_W = opts.charW || 13, LINE_H = 18, PAD_X = 10, PAD_Y = 7;
    const GAP_X = 44, GAP_Y = 10;
    const MAX_CHARS = opts.maxChars || 12, MAX_LINES = 2;
    if (!root || !root.topic) return { nodes: [], links: [], width: 0, height: 0 };

    function wrapText(t) {
      t = String(t || '');
      const lines = [];
      for (let i = 0; i < t.length && lines.length < MAX_LINES; i += MAX_CHARS) {
        lines.push(t.slice(i, i + MAX_CHARS));
      }
      if (t.length > MAX_CHARS * MAX_LINES) {
        lines[MAX_LINES - 1] = lines[MAX_LINES - 1].slice(0, MAX_CHARS - 1) + '…';
      }
      return lines.length ? lines : [' '];
    }

    // 1) 크기·깊이 측정
    function measure(n, depth) {
      const lines = wrapText(n.topic);
      const w = Math.max.apply(null, lines.map(l => l.length)) * CHAR_W + PAD_X * 2;
      const h = lines.length * LINE_H + PAD_Y * 2;
      return { text: n.topic, lines, depth, w, h, x: 0, y: 0, children: (n.children || []).map(c => measure(c, depth + 1)) };
    }
    const t = measure(root, 0);

    // 2) 열 x 좌표 (깊이별 최대 너비 + 간격)
    const colW = [];
    (function scan(n) { colW[n.depth] = Math.max(colW[n.depth] || 0, n.w); n.children.forEach(scan); })(t);
    const colX = [];
    let cx = 0;
    for (let d = 0; d < colW.length; d++) { colX[d] = cx; cx += colW[d] + GAP_X; }

    // 3) y 배치: 리프는 커서 순서대로, 부모는 자식 범위의 가운데
    let cursor = 0;
    (function place(n) {
      n.x = colX[n.depth];
      if (!n.children.length) { n.y = cursor; cursor += n.h + GAP_Y; }
      else {
        n.children.forEach(place);
        const first = n.children[0], last = n.children[n.children.length - 1];
        n.y = (first.y + last.y + last.h) / 2 - n.h / 2;
      }
    })(t);
    let minY = Infinity;
    (function mn(n) { minY = Math.min(minY, n.y); n.children.forEach(mn); })(t);
    const dy = minY < 0 ? -minY : 0;

    // 4) 노드·링크 방출
    const nodes = [], links = [];
    let width = 0, height = 0;
    (function emit(n) {
      n.y += dy;
      nodes.push({ text: n.text, lines: n.lines, depth: n.depth, x: n.x, y: n.y, w: n.w, h: n.h });
      width = Math.max(width, n.x + n.w);
      height = Math.max(height, n.y + n.h);
      for (const c of n.children) {
        emit(c);
        links.push({ x1: n.x + n.w, y1: n.y + n.h / 2, x2: c.x, y2: c.y + c.h / 2 });
      }
    })(t);
    return { nodes, links, width: Math.ceil(width) + 2, height: Math.ceil(height) + 2 };
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
    /* 신형(적응형) 스키마 형태로 감싸 렌더 경로를 단일화한다 (오프라인은 유형 분류 불가 → '기타') */
    return {
      mode: 'local',
      type: '기타',
      summary: summarize(sentences, 5) || '(요약할 텍스트가 없습니다)',
      sections: [],
      mindmap: null,
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

  /* ── AI 개인화 컨텍스트 (설정 personaContext) ──
     비어 있지 않으면 프롬프트 맨 앞에 "사용자 배경: …" 블록으로 주입한다.
     주입 지점: 적응형 요약(runGemini)·오디오 전사(transcribeAudioGemini)·
     Drive 주제 생성(drive.generateTopic). 로컬(오프라인) 요약에는 주입할 곳이 없다. */
  function personaBlock(persona, usage) {
    persona = String(persona == null ? '' : persona).trim();
    if (!persona) return '';
    return '사용자 배경(' + (usage || '항상 참고') + '):\n' + persona + '\n\n';
  }

  async function getPersona() {
    try { return String(await VN.db.getSetting('personaContext', '') || '').trim(); }
    catch (e) { return ''; }
  }

  /* 전사 → 프롬프트용 텍스트·참석자 목록 (요약·Ask AI 공용) */
  function noteTranscript(note) {
    const segs = (note.segments || []).filter(s => s.text && s.text.trim());
    const speakers = note.speakers || [];
    const nameOf = (i) => (speakers[i] && speakers[i].name) || VN.util.speakerDefaultName(i || 0);
    return {
      segs,
      transcript: segs.map(s =>
        '[' + VN.util.fmtTime(s.start) + '] ' + nameOf(s.speaker) + ': ' + s.text
      ).join('\n').slice(0, 100000),
      attendees: [...new Set(segs.map(s => s.speaker || 0))].sort((a, b) => a - b).map(nameOf)
    };
  }

  /* ── Gemini 텍스트 생성 공통 헬퍼: 재시도(429/5xx)·45초 타임아웃 포함, 응답 텍스트 반환.
     무료 등급은 혼잡할 때 503(UNAVAILABLE)/429를 자주 돌려준다. 한 번 실패했다고
     포기하면 품질이 크게 떨어지므로 잠시 기다렸다 다시 시도한다. ── */
  async function geminiGenerate(apiKey, model, body, onRetry) {
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
    return (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
  }

  async function runGemini(note, apiKey, model, quality, onRetry) {
    model = pickModel(model);
    quality = pickQuality(quality);
    const ctx = noteTranscript(note);
    if (!ctx.segs.length) throw new Error('요약할 텍스트가 없습니다.');

    /* 적응형 요약: 회의 고정 스키마 대신, 모델이 먼저 대화 유형을 분류하고
       유형에 맞는 섹션을 스스로 구성한다.
       개인화 컨텍스트가 있으면 유형 분류·섹션 구성·마인드맵 모두 이 배경을 반영한다. */
    const prompt = personaBlock(await getPersona(), '유형 분류·섹션 구성·마인드맵·요약 작성 시 항상 반영하세요') +
      '다음은 음성 녹음의 전사 텍스트입니다. 먼저 대화 유형을 분류하고' +
      '(회의/강의·수업/통화/인터뷰/상담/일상대화/발표/기타 중 하나), 유형에 맞게 정리해 아래 JSON 형식으로만 답하세요(다른 텍스트 금지).\n' +
      '{"type":"유형","summary":"핵심 요약 3~5문장",' +
      '"sections":[{"title":"섹션명","items":["항목"]}],' +
      '"todos":[{"owner":"담당자","task":"할 일","due":"기한"}],"decisions":["결정 사항"],' +
      '"topics":[{"title":"소제목","summary":"한 문장 요약","start":초(number)}],"keywords":["키워드"],' +
      '"mindmap":{"topic":"중심 주제","children":[{"topic":"하위 주제","children":[{"topic":"세부 항목"}]}]}}\n' +
      '규칙:\n' +
      '- sections: 대화 유형에 맞는 섹션을 2~5개 스스로 구성하세요. 예: 강의라면 "핵심 개념"·"예시", ' +
      '통화라면 "용건"·"합의된 내용", 상담이라면 "고민"·"조언", 일상대화라면 "나눈 이야기" 등. ' +
      '회의 형식(결정 사항·안건)을 다른 유형에 강요하지 마세요.\n' +
      '- todos·decisions: 실제로 대화에 존재할 때만 채우고, 없으면 빈 배열 []로 두세요.\n' +
      '- todos의 owner는 반드시 다음 참석자 목록에 있는 이름 중 하나만 사용하세요: [' + ctx.attendees.join(', ') + ']. ' +
      '대화에서 담당자가 명확하지 않으면 빈 문자열("")로 두세요. 추측으로 사람을 지정하지 마세요.\n' +
      '- todos의 due는 대화에 나온 기한 표현을 그대로 쓰고(예: "이번 주 금요일", "8월 15일"), 언급이 없으면 빈 문자열("").\n' +
      '- 간투사(어/음/그 등), 잡음, 무의미한 반복, 웃음·기침 같은 비언어적 소리는 요약·정리에서 제외하세요.\n' +
      '- mindmap: 대화 내용을 카테고리로 묶은 주제 계층. 깊이는 중심 주제 포함 최대 3단계, 노드는 총 30개 이내, 각 topic은 20자 이내.\n' +
      '- topics의 start는 해당 구간이 시작되는 초 단위 숫자입니다. keywords는 5~8개.\n' +
      '- 한국어로 답하되, 대화에서 실제로 사용된 용어와 고유명사는 그대로 유지하세요.\n\n' +
      '--- 전사 ---\n' + ctx.transcript;

    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: buildGenerationConfig(model, 0.3, quality)
    });
    let text = await geminiGenerate(apiKey, model, body, onRetry);
    text = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const jsonStart = text.indexOf('{');
    if (jsonStart > 0) text = text.slice(jsonStart);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('API 응답을 해석하지 못했습니다.'); }
    return normalizeSummary(Object.assign({ mode: 'gemini', model: model }, parsed));
  }

  /* ── Ask AI: 전사 전체(+메모)를 컨텍스트로 자유 질문 ──
     키가 없으면 err.code='no-key'로 던져 UI가 설정 안내를 하게 한다. */
  async function ask(note, question, onRetry) {
    question = String(question || '').trim();
    if (!question) throw new Error('질문을 입력하세요.');
    const apiKey = await VN.db.getSetting('geminiApiKey', '');
    if (!apiKey) {
      const e = new Error('Gemini API 키가 설정되지 않았습니다. (설정 → 고급 모드)');
      e.code = 'no-key';
      throw e;
    }
    const model = pickModel(await VN.db.getSetting('geminiModel', DEFAULT_MODEL));
    const ctx = noteTranscript(note);
    if (!ctx.segs.length) throw new Error('질문에 답할 전사 텍스트가 없습니다.');
    const memoText = (note.memos || []).map(m => '[' + VN.util.fmtTime(m.time) + '] ' + m.text).join('\n');
    const prompt = '아래는 음성 녹음의 전사 텍스트' + (memoText ? '와 사용자 메모' : '') + '입니다. ' +
      '이 내용만을 근거로 질문에 한국어로 간결하게 답하세요. ' +
      '내용에 없는 것은 추측하지 말고 "녹음 내용에서 찾을 수 없습니다"라고 답하세요. 마크다운 없이 일반 텍스트로.\n\n' +
      '--- 전사 ---\n' + ctx.transcript +
      (memoText ? '\n\n--- 메모 ---\n' + memoText : '') +
      '\n\n--- 질문 ---\n' + question;
    const genCfg = buildGenerationConfig(model, 0.3, 'speed');
    delete genCfg.responseMimeType; // 일반 텍스트 응답
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: genCfg
    });
    const text = (await geminiGenerate(apiKey, model, body, onRetry)).trim();
    if (!text) throw new Error('AI 응답이 비어 있습니다.');
    return text;
  }

  /* ── 관용 JSON 배열 파서 (순수 함수 — 셀프테스트 커버) ──
     ① 펜스(```json)·앞쪽 잡담 제거 후 엄격 파싱 시도
     ② 실패하면(MAX_TOKENS로 잘린 응답 등) 마지막 완전한 '}'까지 자르고 ']'를 닫아
        재파싱 — 부분 결과라도 살린다. 실패 시 null. */
  function parseLenientJsonArray(raw) {
    let text = String(raw == null ? '' : raw).trim()
      .replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const jsonStart = text.indexOf('[');
    if (jsonStart > 0) text = text.slice(jsonStart);
    try {
      const a = JSON.parse(text);
      return Array.isArray(a) ? a : null;
    } catch (e) { /* 잘린 JSON — 아래 salvage 시도 */ }
    const lastObj = text.lastIndexOf('}');
    if (lastObj === -1) return null;
    try {
      const a = JSON.parse(text.slice(0, lastObj + 1) + ']');
      return Array.isArray(a) ? a : null;
    } catch (e) { return null; }
  }

  /* ── Gemini 오디오 전사: Blob(≤18MB)을 inlineData로 보내 화자 라벨 세그먼트 획득
       (오디오 전사는 비용이 커서 요약 모델 선택과 무관하게 TRANSCRIBE_MODEL 고정)
     13분 이상 오디오의 전사 JSON은 기본 출력 한도를 초과해 잘리므로 maxOutputTokens를
     모델 한도(65536)로 크게 잡고, 모델이 거부하면 안전값으로 낮춰 다시 보낸다.
     응답이 잘리면 관용 파서로 부분 결과를 살리고, 5xx/429/타임아웃/파싱 실패는 1회 재시도. */
  const TRANSCRIBE_MAX_TOKENS = 65536;
  const TRANSCRIBE_MAX_TOKENS_SAFE = 32768;

  async function transcribeAudioGemini(blob, opts) {
    opts = opts || {};
    const apiKey = await VN.db.getSetting('geminiApiKey', '');
    if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다. (설정 → 고급 모드)');
    if (!(blob instanceof Blob)) throw new Error('오디오가 없습니다.');
    if (blob.size * 4 / 3 > 18 * 1024 * 1024) {
      throw new Error('오디오가 18MB를 초과하여 Gemini 변환을 사용할 수 없습니다. (설정에 Deepgram 키를 등록하면 큰 파일도 자동 변환됩니다)');
    }
    const b64 = await VN.util.blobToBase64(blob);
    const langLabel = { 'ko-KR': '한국어', 'en-US': '영어', 'ja-JP': '일본어', 'zh-CN': '중국어' }[opts.language] || '들리는 언어';
    /* 개인화 컨텍스트 — 도메인 전문 용어(장례·상담 등)를 올바르게 받아 적는 힌트 */
    const prompt = personaBlock(await getPersona(), '전문 용어·고유명사를 올바르게 받아 적는 힌트로만 사용하세요') +
      '첨부된 오디오 전체를 ' + langLabel + '로 전사하세요. ' +
      '각 발화를 {"start": 발화 시작 시각(초, number), "speaker": "참석자1"|"참석자2"|… (목소리로 화자 추정), "text": "발화 내용"} ' +
      '객체로 하는 JSON 배열만 출력하세요. 다른 텍스트 금지. 무음 구간은 건너뛰세요. ' +
      'text는 문장 단위로 끊어 한 객체에 한두 문장만 담으세요.';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + TRANSCRIBE_MODEL + ':generateContent';
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
    const ATTEMPT_TIMEOUT = 45000; // 응답이 없어도 영원히 기다리지 않는다
    const MAX_ATTEMPTS = 2;        // 1회 재시도
    let maxTokens = TRANSCRIBE_MAX_TOKENS;
    let lastMsg = '';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      const genCfg = buildGenerationConfig(TRANSCRIBE_MODEL, 0.2, 'speed');
      genCfg.maxOutputTokens = maxTokens;
      const body = JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: blob.type || 'audio/webm', data: b64 } }
          ]
        }],
        generationConfig: genCfg
      });
      const ctrl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, ATTEMPT_TIMEOUT);
      let resp = null;
      try {
        resp = await fetch(url, { method: 'POST', headers: headers, body: body, signal: ctrl.signal });
      } catch (e) {
        lastMsg = timedOut ? 'Gemini 응답이 45초 안에 오지 않았습니다.' : '네트워크 오류: ' + ((e && e.message) || e);
      } finally { clearTimeout(timer); }
      if (!resp) continue;
      if (!resp.ok) {
        lastMsg = 'Gemini API 오류 (' + resp.status + ')';
        let errText = '';
        try { const j = await resp.json(); if (j.error && j.error.message) { errText = j.error.message; lastMsg += ': ' + errText; } } catch (e) { /* ignore */ }
        // 모델이 maxOutputTokens 값을 거부하면 안전값으로 낮춰 즉시 다시 보낸다 (재시도 횟수 미차감)
        if (resp.status === 400 && /max_?output_?tokens/i.test(errText) && maxTokens > TRANSCRIBE_MAX_TOKENS_SAFE) {
          maxTokens = TRANSCRIBE_MAX_TOKENS_SAFE;
          attempt--;
          continue;
        }
        if (resp.status === 429 || resp.status >= 500) continue;
        throw new Error(lastMsg);
      }
      const data = await resp.json();
      const cand = (data.candidates && data.candidates[0]) || null;
      const text = (cand && cand.content && cand.content.parts && cand.content.parts[0] &&
        cand.content.parts[0].text) || '';
      const arr = parseLenientJsonArray(text);
      if (!arr || !arr.length) {
        lastMsg = (cand && cand.finishReason === 'MAX_TOKENS')
          ? '전사 결과가 출력 한도(MAX_TOKENS)를 넘겨 잘렸고 복구 가능한 부분이 없습니다. 오디오를 나눠 다시 시도해 주세요.'
          : 'Gemini 전사 응답을 해석하지 못했습니다.';
        continue;
      }
      return arr.map(x => ({
        start: Math.max(0, Number(x.start) || 0),
        speakerLabel: String(x.speaker || '참석자1').trim() || '참석자1',
        text: String(x.text || '').trim()
      })).filter(x => x.text);
    }
    throw new Error(lastMsg || 'Gemini 전사에 실패했습니다.');
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
    run, runLocal, runGemini, ask, transcribeAudioGemini, parseLenientJsonArray,
    summarize, splitTopics, extractTodos, keywords, tokenize,
    normalizeSummary, normalizeTodos, groupTodosByOwner,
    normalizeMindmap, mindmapLayout,
    buildGenerationConfig, personaBlock,
    SUMMARY_MODELS, DEFAULT_MODEL, TRANSCRIBE_MODEL,
    QUALITY_MODES, DEFAULT_QUALITY, pickQuality
  };
})();
