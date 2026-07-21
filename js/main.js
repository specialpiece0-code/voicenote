/* VN.demo + 초기화 + window.__vnDebug 테스트 훅 */
window.VN = window.VN || {};

/* ══════════════ 데모 노트 ══════════════ */
VN.demo = (function () {
  const U = () => VN.util;

  /* AudioBuffer → 16bit PCM WAV Blob */
  function encodeWAV(audioBuf) {
    const ch = audioBuf.getChannelData(0);
    const rate = audioBuf.sampleRate;
    const len = ch.length;
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const wStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wStr(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); wStr(8, 'WAVE');
    wStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    wStr(36, 'data'); v.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* WebAudio OfflineAudioContext로 합성한 짧은 톤 WAV (화자별 다른 음높이) */
  async function synthAudio(segments, duration) {
    const rate = 8000;
    const off = new OfflineAudioContext(1, Math.ceil(rate * duration), rate);
    const freqs = [330, 440, 550];
    for (const s of segments) {
      const osc = off.createOscillator();
      const gain = off.createGain();
      osc.frequency.value = freqs[(s.speaker || 0) % freqs.length];
      osc.type = 'sine';
      const st = s.start, en = Math.min(duration, s.end);
      gain.gain.setValueAtTime(0, st);
      gain.gain.linearRampToValueAtTime(0.12, st + 0.05);
      gain.gain.setValueAtTime(0.12, Math.max(st + 0.05, en - 0.05));
      gain.gain.linearRampToValueAtTime(0, en);
      osc.connect(gain).connect(off.destination);
      osc.start(st);
      osc.stop(en);
    }
    const rendered = await off.startRendering();
    return encodeWAV(rendered);
  }

  function demoSegments() {
    const uid = () => VN.util.uid();
    const rows = [
      [0,  0.5,  5.5, '자, 다들 모이셨으니 신제품 런칭 준비 회의를 시작하겠습니다. 오늘 안건은 일정, 마케팅, 예산 세 가지입니다.'],
      [1,  6.0, 10.5, '먼저 일정부터 말씀드리면, 개발은 다음 주 금요일에 코드 프리즈 예정입니다.'],
      [0, 11.0, 14.5, '좋습니다. 그럼 QA 일정은 어떻게 되나요?'],
      [2, 15.0, 20.0, 'QA는 코드 프리즈 후 2주간 진행하고, 8월 첫째 주까지 리그레션 테스트를 완료해야 합니다.', { bookmarked: true }],
      [1, 20.5, 25.5, '런칭일은 8월 15일로 확정하는 게 좋겠습니다. 마케팅 캠페인도 그 날짜에 맞추겠습니다.', { highlighted: true }],
      [0, 26.0, 30.0, '마케팅 예산은 어느 정도로 잡고 있나요? 지난 분기보다 예산이 줄어든 상황이라 확인이 필요합니다.'],
      [2, 30.5, 35.5, '이번 캠페인 예산은 3천만 원으로 잡았고, 소셜 미디어 광고에 60%를 배정할 계획입니다.'],
      [1, 36.0, 40.0, '인플루언서 협업 건은 제가 이번 주 수요일까지 리스트를 정리해서 공유하겠습니다.', { bookmarked: true }],
      [0, 40.5, 44.5, '좋아요. 그리고 보도자료 초안은 홍보팀에 전달해 주세요. 금요일까지 검토가 필요합니다.'],
      [2, 45.0, 49.0, '가격 정책은 월 9,900원 단일 요금제로 가기로 했습니다. 프로모션은 첫 달 무료입니다.', { highlighted: true }],
      [1, 49.5, 53.0, '알겠습니다. 다음 회의 전까지 랜딩 페이지 시안을 준비해야 합니다.'],
      [0, 53.5, 57.0, '정리하겠습니다. 런칭일 8월 15일 확정, 예산 3천만 원, 각자 할 일 확인해 주세요. 수고하셨습니다.']
    ];
    return rows.map(r => Object.assign({
      id: uid(), speaker: r[0], start: r[1], end: r[2], text: r[3],
      bookmarked: false, highlighted: false
    }, r[4] || {}));
  }

  async function seedDemo() {
    const segments = demoSegments();
    const duration = 58;
    let audioBlob = null, waveform = null;
    try {
      audioBlob = await synthAudio(segments, duration);
      // 파형: 세그먼트 구간에서 진폭 표시
      waveform = [];
      const buckets = 240;
      for (let i = 0; i < buckets; i++) {
        const t = i / buckets * duration;
        const inSeg = segments.some(s => t >= s.start && t <= s.end);
        waveform.push(inSeg ? 0.35 + Math.random() * 0.45 : 0.05);
      }
    } catch (e) {
      /* 오디오 합성 실패해도 노트는 생성 */
    }
    const note = VN.db.newNote({
      title: '7월 20일 제품 런칭 회의 (데모)',
      language: 'ko-KR',
      duration,
      audioBlob,
      audioType: 'audio/wav',
      sourceType: 'demo',
      tags: ['회의', '데모'],
      speakers: [{ name: '김팀장' }, { name: '이대리' }, { name: '박매니저' }],
      segments,
      memos: [
        { id: VN.util.uid(), time: 21, text: '런칭일 8/15 — 캘린더에 등록할 것', createdAt: Date.now() },
        { id: VN.util.uid(), time: 46, text: '가격 9,900원/월, 첫 달 무료 프로모션', createdAt: Date.now() }
      ],
      bookmarks: [{ id: VN.util.uid(), time: 15 }, { id: VN.util.uid(), time: 45 }],
      waveform
    });
    await VN.db.saveNote(note);
    if (VN.ui && VN.ui.refresh) await VN.ui.refresh();
    return note;
  }

  return { seedDemo, encodeWAV, synthAudio, demoSegments };
})();

/* ══════════════ 테스트 훅 ══════════════ */
window.__vnDebug = {
  seedDemo: () => VN.demo.seedDemo(),

  async createNoteFromBlob(blob, name) {
    const note = VN.db.newNote({
      title: name || '가져온 오디오',
      audioBlob: blob,
      audioType: blob.type || '',
      sourceType: 'upload'
    });
    await VN.db.saveNote(note);
    return note;
  },

  getState: () => VN.ui.getState(),

  /* 요약기·SRT/TXT·검색·find&replace·DB CRUD·백업 직렬화를 실제 실행 */
  async runSelfTest() {
    const results = [];
    const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail || '' });

    // 테스트용 노트 (저장하지 않음)
    const fake = VN.db.newNote({
      title: '셀프테스트 회의',
      duration: 30,
      speakers: [{ name: '테스터A' }, { name: '테스터B' }],
      segments: [
        { id: 'a', speaker: 0, start: 0, end: 5, text: '오늘 예산 관련 회의를 시작하겠습니다.', bookmarked: false, highlighted: false },
        { id: 'b', speaker: 1, start: 5.5, end: 12, text: '예산 보고서는 금요일까지 공유하겠습니다.', bookmarked: false, highlighted: false },
        { id: 'c', speaker: 0, start: 12.5, end: 20, text: '마케팅 계획도 검토해 주세요.', bookmarked: false, highlighted: false }
      ],
      memos: [{ id: 'm', time: 6, text: '예산 확인 메모', createdAt: Date.now() }]
    });

    // 1) 요약기
    try {
      const sum = VN.summarizer.runLocal(fake);
      t('summarizer.runLocal', sum.summary.length > 0 && sum.keywords.length > 0 && sum.todos.length > 0 && sum.topics.length > 0,
        'keywords=' + sum.keywords.join(',') + ' todos=' + sum.todos.length);
    } catch (e) { t('summarizer.runLocal', false, String(e)); }

    // 1-b) 요약 스키마 정규화 (구형 문자열 todos → {owner,task,due} 객체 + 담당자별 그룹)
    try {
      const old = { mode: 'gemini', summary: '예전 요약', todos: ['금요일까지 보고서 공유', '랜딩 시안 준비'], keywords: ['예산'] };
      const n = VN.summarizer.normalizeSummary(old);
      const nw = VN.summarizer.normalizeSummary({
        summary: 's', decisions: ['런칭일 8/15 확정'], openIssues: ['채널 미정'],
        todos: [{ owner: '김팀장', task: '예산 확정', due: '이번 주 금요일' }, { task: '시안 준비' }]
      });
      const groups = VN.summarizer.groupTodosByOwner(nw.todos);
      t('summarizer.normalizeSummary',
        n.todos.length === 2 && n.todos[0].task === '금요일까지 보고서 공유' && n.todos[0].owner === '' && n.todos[0].due === '' &&
        Array.isArray(n.decisions) && n.decisions.length === 0 && Array.isArray(n.openIssues) && n.openIssues.length === 0 &&
        nw.decisions[0] === '런칭일 8/15 확정' && nw.openIssues[0] === '채널 미정' &&
        nw.todos[0].owner === '김팀장' && nw.todos[0].due === '이번 주 금요일' &&
        groups.length === 2 && groups[0].owner === '김팀장' && groups[0].items[0].index === 0 &&
        groups[1].owner === '미지정' && groups[1].items[0].index === 1,
        'old.todos→' + JSON.stringify(n.todos[0]) + ' groups=' + groups.map(g => g.owner).join('/'));
    } catch (e) { t('summarizer.normalizeSummary', false, String(e)); }

    // 2) SRT/TXT/VTT 생성
    try {
      const srt = VN.exporter.toSRT(fake);
      t('exporter.toSRT', /^1\r\n00:00:00,000 --> 00:00:05,000/.test(srt) && srt.includes('테스터A'), srt.slice(0, 40));
    } catch (e) { t('exporter.toSRT', false, String(e)); }
    try {
      const txt = VN.exporter.toTXT(fake, { speaker: true, time: true, memos: true });
      t('exporter.toTXT', txt.includes('[00:00] 테스터A:') && txt.includes('--- 메모 ---'), txt.split('\r\n')[3] || '');
    } catch (e) { t('exporter.toTXT', false, String(e)); }
    try {
      const vtt = VN.exporter.toVTT(fake);
      t('exporter.toVTT', vtt.startsWith('WEBVTT') && vtt.includes('00:00:05.500 --> 00:00:12.000'), '');
    } catch (e) { t('exporter.toVTT', false, String(e)); }

    // 3) 전역 검색
    try {
      const r1 = VN.ui.searchNotes([fake], '예산');
      const r2 = VN.ui.searchNotes([fake], '존재하지않는단어xyz');
      t('search.global', r1.length === 1 && r1[0].snippet && r1[0].snippet.includes('예산') && r2.length === 0,
        'hit=' + r1.length + ' miss=' + r2.length);
    } catch (e) { t('search.global', false, String(e)); }

    // 4) 찾아 바꾸기
    try {
      const clone = JSON.parse(JSON.stringify(fake));
      const n = VN.ui.replaceInNote(clone, '예산', '버짓');
      t('search.replaceInNote', n === 2 && clone.segments[0].text.includes('버짓') && !clone.segments[0].text.includes('예산'),
        'replaced=' + n);
    } catch (e) { t('search.replaceInNote', false, String(e)); }

    // 5) DB CRUD (임시 데이터 정리 포함)
    const testId = '__vntest-' + Date.now();
    try {
      const note = VN.db.newNote({ id: testId, title: 'CRUD 테스트' });
      await VN.db.saveNote(note);
      const got = await VN.db.getNote(testId);
      note.title = 'CRUD 수정됨';
      await VN.db.saveNote(note);
      const got2 = await VN.db.getNote(testId);
      await VN.db.trashNote(testId);
      const inTrash = (await VN.db.getTrash()).some(x => x.id === testId);
      await VN.db.purgeNote(testId);
      const gone = !(await VN.db.getNote(testId)) && !(await VN.db.getTrash()).some(x => x.id === testId);
      t('db.crud', got && got.title === 'CRUD 테스트' && got2.title === 'CRUD 수정됨' && inTrash && gone, '');
    } catch (e) {
      try { await VN.db.del('notes', testId); await VN.db.del('trash', testId); } catch (e2) { /* ignore */ }
      t('db.crud', false, String(e));
    }

    // 6) 백업 직렬화
    try {
      const bk = await VN.db.backup(false);
      const json = JSON.stringify(bk);
      t('db.backup', bk.app === 'voicenote' && Array.isArray(bk.notes) && json.length > 50, 'bytes=' + json.length);
    } catch (e) { t('db.backup', false, String(e)); }

    // 7) Drive 파일명 생성기 (금지문자 치환 + 주제 폴백)
    try {
      const dn = { createdAt: new Date(2026, 6, 20, 14, 5).getTime() };
      const fn = VN.drive.makeFilename(dn, '예산/회의:*안건이매우길어서잘림?', 'doc');
      const noBad = !/[\\/:*?"<>|]/.test(fn);
      const topicPart = fn.slice('2026-07-20_1405_'.length).replace(/\.doc$/, '');
      const fallback = VN.drive.localTopic(fake); // 키워드 상위 2개 폴백
      t('drive.makeFilename', fn.startsWith('2026-07-20_1405_') && fn.endsWith('.doc') && noBad &&
        topicPart.length > 0 && topicPart.length <= 15 && fallback.length > 0,
        fn + ' / fallback=' + fallback);
    } catch (e) { t('drive.makeFilename', false, String(e)); }

    // 8) 웹훅 페이로드 직렬화/역직렬화
    try {
      const p = VN.drive.buildWebhookPayload('tok123', '2026-07-20_1405_회의.doc', 'application/msword', 'QUJDRA==');
      const parsed = JSON.parse(p);
      t('drive.webhookPayload',
        parsed.token === 'tok123' && parsed.filename === '2026-07-20_1405_회의.doc' &&
        parsed.mimeType === 'application/msword' && atob(parsed.dataBase64) === 'ABCD', '');
    } catch (e) { t('drive.webhookPayload', false, String(e)); }

    // 9) 녹음 복구 스냅샷 저장 → 복원 (recChunks store)
    try {
      await VN.db.put('recChunks', { id: '__t-meta', elapsed: 12, segments: [{ text: '복구테스트' }], mimeType: 'audio/webm' });
      await VN.db.put('recChunks', { id: '__t-c1', idx: 1, blob: new Blob(['ab']) });
      await VN.db.put('recChunks', { id: '__t-c2', idx: 2, blob: new Blob(['cd']) });
      const meta = await VN.db.get('recChunks', '__t-meta');
      const chunkRecs = (await VN.db.getAll('recChunks')).filter(r => String(r.id).startsWith('__t-c'));
      const blob = VN.recorder.assembleChunks(chunkRecs);
      const text = await blob.text();
      await VN.db.del('recChunks', '__t-meta');
      await VN.db.del('recChunks', '__t-c1');
      await VN.db.del('recChunks', '__t-c2');
      t('recovery.snapshot', meta && meta.elapsed === 12 && meta.segments[0].text === '복구테스트' &&
        blob.size === 4 && text === 'abcd', 'assembled=' + text);
    } catch (e) {
      try { await VN.db.del('recChunks', '__t-meta'); await VN.db.del('recChunks', '__t-c1'); await VN.db.del('recChunks', '__t-c2'); } catch (e2) { /* ignore */ }
      t('recovery.snapshot', false, String(e));
    }

    // 12) Drive multipart 본문 조립 (경계 구분 + 메타데이터 JSON 파싱 가능 여부)
    try {
      const boundary = 'vn-test-boundary';
      const body = VN.drive.buildMultipartBody(
        { name: '2026-07-20_1405_회의.doc', parents: ['FOLDER1'] },
        'application/msword', 'QUJDRA==', boundary);
      const parts = body.split('--' + boundary);       // ['', 메타, 미디어, '--']
      const meta = JSON.parse((parts[1] || '').split('\r\n\r\n')[1].trim());
      const media = parts[2] || '';
      const b64 = (media.split('\r\n\r\n')[1] || '').trim();
      t('drive.multipartBody',
        parts.length === 4 && body.endsWith('--' + boundary + '--') &&
        meta.name === '2026-07-20_1405_회의.doc' && meta.parents[0] === 'FOLDER1' &&
        media.indexOf('Content-Type: application/msword') !== -1 && atob(b64) === 'ABCD',
        'parts=' + parts.length + ' name=' + meta.name);
    } catch (e) { t('drive.multipartBody', false, String(e)); }

    // 13) 캘린더 이벤트 → 제목/참석자 매핑 (+ 파일명 주제로 캘린더 제목 우선)
    try {
      const ev = {
        id: 'ev1', summary: '  주간 제품 회의  ',
        start: { dateTime: '2026-07-20T14:00:00+09:00' },
        attendees: [
          { displayName: '김팀장', email: 'kim@example.com' },
          { email: 'lee.dev@example.com' },                                  // displayName 없음 → 로컬파트
          { email: 'room-a@resource.calendar.google.com', resource: true }   // 회의실 제외
        ]
      };
      const names = VN.gcal.attendeeNames(ev);
      const cal = VN.gcal.toNoteCalendar(ev);
      const topic = VN.drive.calendarTopic({ calendar: { title: '분기별 예산 검토 및 승인 회의' } });
      t('gcal.eventMapping',
        VN.gcal.eventTitle(ev) === '주간 제품 회의' && VN.gcal.eventTitle({}) === '(제목 없음)' &&
        names.length === 2 && names[0] === '김팀장' && names[1] === 'lee.dev' &&
        cal.id === 'ev1' && cal.title === '주간 제품 회의' &&
        cal.start === Date.parse('2026-07-20T14:00:00+09:00') &&
        topic.length > 0 && topic.length <= 15 &&
        '분기별 예산 검토 및 승인 회의'.indexOf(topic) === 0 && VN.drive.calendarTopic({}) === '',
        'attendees=' + names.join(',') + ' topic=' + topic);
    } catch (e) { t('gcal.eventMapping', false, String(e)); }

    // 14) 토큰 만료 판정 (발급 + expires_in − 60초)
    try {
      const t0 = 1700000000000;
      const exp = VN.gauth.computeExpiry(t0, 3600);
      const bad = VN.gauth.computeExpiry(t0, 'nope');
      t('gauth.tokenExpiry',
        exp === t0 + 3540000 && bad === 0 &&
        VN.gauth.isTokenValid({ accessToken: 'x', expiresAt: exp }, t0 + 1000) === true &&
        VN.gauth.isTokenValid({ accessToken: 'x', expiresAt: exp }, exp + 1) === false &&
        VN.gauth.isTokenValid({ expiresAt: exp }, t0) === false &&
        VN.gauth.isTokenValid(null, t0) === false,
        'expiresIn=3600 → +' + ((exp - t0) / 1000) + 's');
    } catch (e) { t('gauth.tokenExpiry', false, String(e)); }

    // 15) 요약 품질 모드 → generationConfig (fetch를 가로채 실제 요청 본문 확인)
    try {
      const origFetch = window.fetch;
      const bodies = [];
      window.fetch = async (url, opts) => {
        bodies.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"summary":"s"}' }] } }] }) };
      };
      try {
        await VN.summarizer.runGemini(fake, 'test-key', VN.summarizer.DEFAULT_MODEL, 'quality');
        await VN.summarizer.runGemini(fake, 'test-key', VN.summarizer.DEFAULT_MODEL, 'speed');
      } finally { window.fetch = origFetch; }
      const q = bodies[0] && bodies[0].generationConfig;
      const s = bodies[1] && bodies[1].generationConfig;
      t('summarizer.qualityMode',
        bodies.length === 2 && q && s && !q.thinkingConfig && s.thinkingConfig && s.thinkingConfig.thinkingBudget === 0,
        'quality=' + JSON.stringify((q || {}).thinkingConfig || null) + ' speed=' + JSON.stringify((s || {}).thinkingConfig || null));
    } catch (e) { t('summarizer.qualityMode', false, String(e)); }

    // 16) 로컬 주제/키워드 — 연결어미로 끝나는 토큰("했는지", "모르겠으나" 등) 제외
    try {
      const n2 = VN.db.newNote({
        segments: [{
          id: 'e1', speaker: 0, start: 0, end: 5,
          text: '오늘은 뭘 했는지 모르겠으나 오늘도 아무튼 열심히 살았다',
          bookmarked: false, highlighted: false
        }]
      });
      const topic = VN.drive.localTopic(n2);
      const kws = VN.summarizer.keywords(n2.segments[0].text, 8);
      t('drive.localTopicEndings',
        topic.length > 0 && topic.indexOf('했는지') === -1 && topic.indexOf('모르겠으나') === -1 &&
        kws.indexOf('했는지') === -1 && kws.indexOf('모르겠으나') === -1,
        'topic=' + topic + ' kws=' + kws.join(','));
    } catch (e) { t('drive.localTopicEndings', false, String(e)); }

    // 17) 백업 직렬화에 민감 설정(API 키·구글 토큰·폴더 핸들) 부재 + 복원 시 무시
    try {
      const SENS = ['geminiApiKey', 'deepgramApiKey', 'assemblyaiApiKey', 'googleToken', 'driveDirHandle'];
      const prevRow = await VN.db.get('settings', 'deepgramApiKey'); // 원상복구용
      await VN.db.setSetting('deepgramApiKey', '__vntest-secret');
      const bk2 = await VN.db.backup(false);
      const leaked = JSON.stringify(bk2).indexOf('__vntest-secret') !== -1 ||
        (bk2.settings || []).some(s => SENS.indexOf(s.key) !== -1);
      // 복원 시 민감 키가 들어 있어도 무시하는지 (notes/settings 외 데이터는 건드리지 않음)
      await VN.db.restoreBackup({ app: 'voicenote', notes: [], settings: [{ key: 'deepgramApiKey', value: '__vntest-inject' }] });
      const afterRestore = await VN.db.getSetting('deepgramApiKey', '');
      if (prevRow) await VN.db.put('settings', prevRow); else await VN.db.del('settings', 'deepgramApiKey');
      t('db.backupSensitiveKeys', !leaked && afterRestore === '__vntest-secret',
        'leaked=' + leaked + ' restoreIgnored=' + (afterRestore === '__vntest-secret'));
    } catch (e) {
      try { await VN.db.del('settings', 'deepgramApiKey'); } catch (e2) { /* ignore */ }
      t('db.backupSensitiveKeys', false, String(e));
    }

    // 19) 관용 JSON 배열 파서 (펜스·잘린 응답 salvage)
    try {
      const P = VN.summarizer.parseLenientJsonArray;
      const full = P('[{"start":0,"speaker":"참석자1","text":"a"},{"start":5,"speaker":"참석자2","text":"b"}]');
      const fenced = P('```json\n[{"start":0,"speaker":"s","text":"t"}]\n```');
      const chatty = P('결과입니다: [{"start":1,"speaker":"s","text":"x"}]');
      const truncated = P('[{"start":0,"speaker":"참석자1","text":"a"},{"start":5,"speaker":"참석자2","text":"b"},{"start":9,"spea');
      const trailing = P('[{"start":0,"speaker":"s","text":"a"},');
      const garbage = P('전사에 실패했습니다');
      const notArray = P('{"start":0}');
      t('summarizer.parseLenientJsonArray',
        full && full.length === 2 && full[1].text === 'b' &&
        fenced && fenced.length === 1 && fenced[0].text === 't' &&
        chatty && chatty.length === 1 &&
        truncated && truncated.length === 2 && truncated[1].speaker === '참석자2' &&
        trailing && trailing.length === 1 &&
        garbage === null && notArray === null,
        'truncated→' + (truncated ? truncated.length : 'null') + '개 salvage');
    } catch (e) { t('summarizer.parseLenientJsonArray', false, String(e)); }

    // 20) 문장 단위 세그먼트 청커 (화자 전환·문장 종결·침묵 1.2초·140자 상한 분리)
    try {
      const M = VN.diarize._test.mergeWords;
      const W = (word, start, end, speaker) => ({ punctuated_word: word, start, end, speaker });
      const bySentence = M([W('안녕하세요.', 0, 1, 0), W('반갑습니다.', 1.1, 2, 0), W('네', 2.1, 2.5, 0)]);
      const byGap = M([W('하나', 0, 1, 0), W('둘', 2.5, 3, 0)]);           // 1.5초 침묵 > 1.2초
      const bySpeaker = M([W('하나', 0, 1, 0), W('둘', 1.1, 2, 1)]);
      const merged = M([W('하나', 0, 1, 0), W('둘', 1.1, 2, 0)]);          // 분리 조건 없음 → 병합
      const long = M(Array.from({ length: 60 }, (_, i) => W('열글자쯤되는단어입니다', i * 0.5, i * 0.5 + 0.4, 0)));
      t('diarize.sentenceChunks',
        bySentence.length === 3 && bySentence[0].text === '안녕하세요.' && bySentence[1].text === '반갑습니다.' &&
        byGap.length === 2 && bySpeaker.length === 2 &&
        merged.length === 1 && merged[0].text === '하나 둘' &&
        long.length > 1 && long.every(s => s.text.length <= 140),
        'sentence=' + bySentence.length + ' gap=' + byGap.length + ' long=' + long.length + '개(최대 ' +
        Math.max.apply(null, long.map(s => s.text.length)) + '자)');
    } catch (e) { t('diarize.sentenceChunks', false, String(e)); }

    // 21) 자동 전사 관리자 — 엔진 체인 우선순위 + 결과 적용 매핑
    try {
      const T = VN.transcribe._test;
      const c1 = T.chainFromKeys({ deepgram: true, assemblyai: true, gemini: true });
      const c2 = T.chainFromKeys({ gemini: true });
      const c3 = T.chainFromKeys({});
      const dn = { segments: [], speakers: [] };
      T.applyDiarizeSegments(dn, { segments: [{ start: 0, end: 2, speaker: 0, text: 'a' }, { start: 3, end: 5, speaker: 1, text: 'b' }] });
      const gn = { segments: [], speakers: [] };
      T.applyGeminiSegments(gn, [
        { start: 0, speakerLabel: '참석자1', text: 'x' },
        { start: 4, speakerLabel: '참석자2', text: 'y' }
      ]);
      t('transcribe.autoManager',
        c1.join(',') === 'deepgram,assemblyai,gemini' && c2.join(',') === 'gemini' && c3.length === 0 &&
        dn.segments.length === 2 && dn.speakers.length === 2 && dn.segments[1].speaker === 1 &&
        dn.speakers[0].name === '참석A' && dn.speakers[1].name === '참석B' &&
        gn.segments.length === 2 && gn.speakers[0].name === '참석A' && gn.speakers[1].name === '참석B' &&
        gn.segments[0].end === 4 && gn.segments[1].end === 7,
        'chain=' + c1.join('>') + ' speakers=' + gn.speakers.map(s => s.name).join(','));
    } catch (e) { t('transcribe.autoManager', false, String(e)); }

    // 23) 화자 체계 (참석A/B… 기본명 + 아바타 표시 글자)
    try {
      const L = VN.util;
      t('util.speakerNaming',
        L.speakerLetter(0) === 'A' && L.speakerLetter(25) === 'Z' && L.speakerLetter(26) === 'AA' &&
        L.speakerDefaultName(0) === '참석A' && L.speakerDefaultName(2) === '참석C' &&
        L.speakerInitial('참석B') === 'B' && L.speakerInitial('참석AA') === 'AA' &&
        L.speakerInitial('참석자 3') === '3' && L.speakerInitial('참석자1') === '1' &&
        L.speakerInitial('김팀장') === '김팀' && L.speakerInitial('') === '?',
        'A/Z/AA=' + [L.speakerLetter(0), L.speakerLetter(25), L.speakerLetter(26)].join(','));
    } catch (e) { t('util.speakerNaming', false, String(e)); }

    // 24) 적응형 요약 스키마 정규화 (신형 type·sections·mindmap + 구형 하위 호환 + 깊이·노드 상한)
    try {
      const neu = VN.summarizer.normalizeSummary({
        mode: 'gemini', type: '통화', summary: 's',
        sections: [{ title: '용건', items: ['요금 문의'] }, { title: '', items: [] }],
        todos: [], decisions: [],
        mindmap: { topic: '통화', children: [{ topic: '요금', children: [{ topic: '약정', children: [{ topic: '깊이4' }] }] }] }
      });
      const old = VN.summarizer.normalizeSummary({ mode: 'gemini', summary: '예전', todos: ['a'] });
      const wide = VN.summarizer.normalizeMindmap({
        topic: 'root',
        children: Array.from({ length: 40 }, (_, i) => ({ topic: '자식' + i }))
      });
      t('summarizer.adaptiveSchema',
        neu.type === '통화' && neu.sections.length === 1 && neu.sections[0].items[0] === '요금 문의' &&
        neu.mindmap && neu.mindmap.topic === '통화' &&
        neu.mindmap.children[0].children[0].topic === '약정' &&
        neu.mindmap.children[0].children[0].children.length === 0 &&   // 깊이 3 초과 절단
        old.type === '' && old.sections.length === 0 && old.mindmap === null &&
        old.todos.length === 1 && old.todos[0].task === 'a' &&          // 구형 하위 호환 유지
        wide.children.length === 29,                                    // 루트 포함 30개 상한
        'depth-cut=' + neu.mindmap.children[0].children[0].children.length + ' nodeCap=' + (1 + wide.children.length));
    } catch (e) { t('summarizer.adaptiveSchema', false, String(e)); }

    // 25) 마인드맵 가로 트리 레이아웃 (깊이→x 열, 줄바꿈·말줄임, 좌표 유한성)
    try {
      const lay = VN.summarizer.mindmapLayout({
        topic: '중심 주제', children: [
          { topic: '아주 길어서 줄바꿈과 말줄임이 반드시 필요한 주제 이름입니다', children: [{ topic: '세부' }] },
          { topic: '짧음' }
        ]
      });
      const byDepth = (d) => lay.nodes.filter(n => n.depth === d);
      const longNode = lay.nodes.find(n => n.text.indexOf('아주 길어서') === 0);
      const empty = VN.summarizer.mindmapLayout(null);
      t('summarizer.mindmapLayout',
        lay.nodes.length === 4 && lay.links.length === 3 && lay.width > 0 && lay.height > 0 &&
        byDepth(0)[0].x < byDepth(1)[0].x && byDepth(1)[0].x < byDepth(2)[0].x &&
        longNode.lines.length === 2 && longNode.lines[1].slice(-1) === '…' &&
        lay.nodes.every(n => isFinite(n.x) && isFinite(n.y) && n.w > 0 && n.h > 0 && n.y >= 0) &&
        empty.nodes.length === 0 && empty.links.length === 0,
        'nodes=' + lay.nodes.length + ' size=' + lay.width + 'x' + lay.height);
    } catch (e) { t('summarizer.mindmapLayout', false, String(e)); }

    // 18) 모바일 UA 감지 (Android/iOS + iPadOS 데스크톱 모드 포함, 데스크톱 제외)
    try {
      const f = VN.ui.isMobileUA;
      t('ui.isMobileUA',
        f('Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36', 5) === true &&
        f('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', 5) === true &&
        f('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5) === true && // iPadOS 데스크톱 모드
        f('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 0) === false &&
        f('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0) === false && // 진짜 Mac
        f('', 0) === false,
        '');
    } catch (e) { t('ui.isMobileUA', false, String(e)); }

    console.table(results);
    return results;
  }
};

/* ══════════════ 초기화 ══════════════ */
(async function () {
  try {
    await VN.db.open();
    await VN.db.purgeExpiredTrash();   // 30일 지난 휴지통 자동 영구삭제
  } catch (e) {
    console.error('DB 초기화 실패', e);
  }
  await VN.ui.init();

  // 로컬 복사본 구분 배지 — 실사용 주소(배포)와 저장소가 분리돼 있어 혼동 방지
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    const b = document.createElement('a');
    b.href = 'https://voicenote-l0ox.onrender.com';
    b.textContent = '🧪 로컬 테스트 복사본 — 실사용(키·노트 저장)은 voicenote-l0ox.onrender.com';
    b.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;text-align:center;' +
      'padding:6px 10px;font-size:12px;background:#7c5c00;color:#fff;text-decoration:none;opacity:.95';
    document.body.appendChild(b);
  }

  // PWA 서비스 워커 (network-first — sw.js 참고)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 등록 실패해도 앱 동작에는 영향 없음 */ });
  }
})();
