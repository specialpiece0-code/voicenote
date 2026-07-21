/* VN.transcribe — 자동 전사 관리자 (사용자에게 방식을 묻지 않는다)
   엔진 우선순위: Deepgram(키 있으면, diarize=true 화자분리) → AssemblyAI(키 있으면 예비)
   → Gemini(키 있으면) → 키가 하나도 없으면 안내 문구로 실패 처리.

   백그라운드 동작: start()는 노트에 transcribePending 플래그를 저장하고 즉시 반환,
   변환은 뒤에서 진행된다. 완료·실패 시 플래그를 해제하고 리스너(setListener)로 알린다.
   앱 시작 시 resumePending()이 pending 노트를 자동 재개한다 — 탭을 닫아 요청이 끊겨도
   다음 실행 때 이어서 처리되는 구조. */
window.VN = window.VN || {};

VN.transcribe = (function () {

  const active = new Set();   // 진행 중인 노트 id — 동일 노트 중복 시작 방지
  let listener = null;        // (note, phase) => void
                              // phase: 'start' | 'done' | 'error'(변환 실행 후 실패) | 'blocked'(키 없음 등 시작 불가)

  function setListener(fn) { listener = (typeof fn === 'function') ? fn : null; }

  function notify(note, phase) {
    if (listener) { try { listener(note, phase); } catch (e) { /* UI 오류가 변환을 막지 않게 */ } }
  }

  /* ── 순수 함수: 보유 키 → 엔진 체인 (셀프테스트 커버) ── */
  function chainFromKeys(keys) {
    keys = keys || {};
    const chain = [];
    if (keys.deepgram) chain.push('deepgram');
    if (keys.assemblyai) chain.push('assemblyai');
    if (keys.gemini) chain.push('gemini');
    return chain;
  }

  async function availableChain() {
    const [dg, aai, gem] = await Promise.all([
      VN.db.getSetting('deepgramApiKey', ''),
      VN.db.getSetting('assemblyaiApiKey', ''),
      VN.db.getSetting('geminiApiKey', '')
    ]);
    return chainFromKeys({
      deepgram: !!(dg || '').trim(),
      assemblyai: !!(aai || '').trim(),
      gemini: !!(gem || '').trim()
    });
  }

  /* ── 순수 함수: 전사 결과 → 노트 세그먼트·참석자 적용 ── */

  /* Deepgram/AssemblyAI 결과 (speaker: 0..N 정수) */
  function applyDiarizeSegments(note, result) {
    const segs = (result && Array.isArray(result.segments)) ? result.segments : [];
    let maxSp = 0;
    for (const s of segs) maxSp = Math.max(maxSp, Math.max(0, s.speaker | 0));
    const speakers = [];
    for (let i = 0; i <= maxSp; i++) speakers.push({ name: VN.util.speakerDefaultName(i) });
    note.speakers = speakers;
    note.segments = segs.map(s => {
      const start = Number(s.start) || 0;
      const end = Number(s.end);
      return {
        id: VN.util.uid(),
        speaker: Math.max(0, s.speaker | 0),
        start: start,
        end: (isFinite(end) && end > start) ? end : start + 3,
        text: String(s.text || ''),
        bookmarked: false, highlighted: false
      };
    });
  }

  /* Gemini 결과 (speakerLabel: '참석자1' 등 문자열 라벨) —
     라벨을 등장 순서대로 새 화자 체계(참석A, 참석B…)에 매핑한다 */
  function applyGeminiSegments(note, items) {
    const labels = [];
    for (const it of items) if (!labels.includes(it.speakerLabel)) labels.push(it.speakerLabel);
    if (!labels.length) labels.push('참석자1');
    note.speakers = labels.map((l, i) => ({ name: VN.util.speakerDefaultName(i) }));
    note.segments = items.map((it, i) => ({
      id: VN.util.uid(),
      speaker: Math.max(0, labels.indexOf(it.speakerLabel)),
      start: it.start,
      end: items[i + 1] ? Math.max(it.start, items[i + 1].start) : it.start + 3,
      text: it.text,
      bookmarked: false, highlighted: false
    }));
  }

  /* ── 엔진 하나 실행 → 노트에 적용 (성공 시 세그먼트 1개 이상 보장) ── */
  async function runEngine(engine, note) {
    if (engine === 'gemini') {
      const items = await VN.summarizer.transcribeAudioGemini(note.audioBlob, { language: note.language });
      if (!items.length) throw new Error('인식된 음성이 없습니다.');
      applyGeminiSegments(note, items);
    } else {
      const r = await VN.diarize.transcribe(note.audioBlob, { provider: engine, language: note.language });
      if (!r.segments.length) throw new Error('인식된 음성이 없습니다.');
      applyDiarizeSegments(note, r);
    }
  }

  /* ── 백그라운드 본체 ── */
  async function run(noteId, chain) {
    let applied = null;   // 성공한 엔진 결과가 반영된 노트
    let lastErr = null;
    for (const engine of chain) {
      // 항상 DB의 최신 노트에 적용한다 (변환 중 제목·메모 편집 유실 방지)
      let note = null;
      try { note = await VN.db.getNote(noteId); } catch (e) { note = null; }
      if (!note) { active.delete(noteId); return; }  // 변환 중 삭제됨 — 조용히 종료
      if (!(note.audioBlob instanceof Blob)) { lastErr = new Error('오디오가 없습니다.'); break; }
      try {
        await runEngine(engine, note);
        applied = note;
        break;
      } catch (e) { lastErr = e; }
    }
    active.delete(noteId);
    const note = applied || (await VN.db.getNote(noteId).catch(() => null));
    if (!note) return;
    note.transcribePending = false;
    note.transcribeError = applied ? null
      : ('텍스트 변환에 실패했습니다: ' + ((lastErr && lastErr.message) || lastErr || '알 수 없는 오류'));
    try { await VN.db.saveNote(note); } catch (e) { /* ignore */ }
    notify(note, applied ? 'done' : 'error');
  }

  /* ── 진입점: 노트 저장 직후·재변환·재시도 공용.
       반환 {started:bool, reason?} — 시작 못 하면 이유를 준다. ── */
  async function start(note) {
    if (!note || !note.id) return { started: false, reason: 'no-note' };
    if (active.has(note.id)) return { started: false, reason: 'already' };
    if (!(note.audioBlob instanceof Blob)) return { started: false, reason: 'no-audio' };
    const chain = await availableChain();
    if (!chain.length) {
      note.transcribePending = false;
      note.transcribeError = '전사 엔진 키가 없습니다. 설정에서 Deepgram 또는 Gemini 키를 등록하세요.';
      try { await VN.db.saveNote(note); } catch (e) { /* ignore */ }
      notify(note, 'blocked');
      return { started: false, reason: 'no-keys' };
    }
    active.add(note.id);
    note.transcribePending = true;
    note.transcribeError = null;
    try { await VN.db.saveNote(note); } catch (e) { /* ignore */ }
    notify(note, 'start');
    run(note.id, chain); // await 없이 백그라운드 진행
    return { started: true };
  }

  /* 앱 시작 시: pending으로 남은 노트(탭을 닫아 끊긴 변환)를 자동 재개 */
  async function resumePending() {
    let notes = [];
    try { notes = await VN.db.getAllNotes(); } catch (e) { return 0; }
    let n = 0;
    for (const note of notes) {
      if (!note.transcribePending) continue;
      if (note.audioBlob instanceof Blob) {
        const r = await start(note);
        if (r.started) n++;
      } else {
        note.transcribePending = false;
        note.transcribeError = '오디오가 없어 변환을 재개할 수 없습니다.';
        try { await VN.db.saveNote(note); } catch (e) { /* ignore */ }
      }
    }
    return n;
  }

  function isActive(id) { return active.has(id); }
  function activeCount() { return active.size; }

  return {
    start, resumePending, isActive, activeCount, setListener,
    _test: { chainFromKeys, applyDiarizeSegments, applyGeminiSegments }
  };
})();
