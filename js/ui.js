/* VN.ui — 화면 렌더링·라우팅·검색·폴더·휴지통·설정 등 앱 로직 */
window.VN = window.VN || {};

VN.ui = (function () {
  const U = VN.util;
  const COLORS = ['#03C75A', '#4C7CFF', '#F5A623', '#E5484D', '#9B59B6', '#16A2B8', '#FF7A45', '#607D8B'];

  /* ── 상태 ── */
  const S = {
    notes: [], folders: [],
    sort: 'recent',            // recent | title | duration
    listQuery: '',
    player: null,              // 현재 노트 플레이어
    note: null,                // 현재 열린 노트
    noteTab: 'seg',            // seg | memo | ai
    segFilter: 'all',          // all | bookmark | highlight
    noteSearch: { q: '', matches: [], cur: -1 },
    pendingJump: null,         // 전역 검색 → 노트 열 때 점프할 검색어
    editingSeg: null,
    rec: null,                 // 녹음 세션 상태
    theme: 'system'
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const main = () => $('#main');

  /* ══════════════ 공통 헬퍼 ══════════════ */

  function toast(msg, ms) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toast-root').appendChild(el);
    setTimeout(() => el.remove(), ms || 2600);
  }

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = '<div class="modal">' + html + '</div>';
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    $('#modal-root').appendChild(back);
    return back;
  }
  function confirmModal(title, body, okLabel, danger) {
    return new Promise((res) => {
      const m = modal(
        '<h2>' + U.esc(title) + '</h2><div class="modal-body">' + body + '</div>' +
        '<div class="modal-actions"><button class="btn" data-x="no">취소</button>' +
        '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-x="ok">' + U.esc(okLabel || '확인') + '</button></div>'
      );
      $('[data-x="ok"]', m).onclick = () => { m.remove(); res(true); };
      $('[data-x="no"]', m).onclick = () => { m.remove(); res(false); };
    });
  }
  function promptModal(title, label, value) {
    return new Promise((res) => {
      const m = modal(
        '<h2>' + U.esc(title) + '</h2><div class="modal-body"><div class="form-row"><label>' + U.esc(label) + '</label>' +
        '<input type="text" id="pm-input" value="' + U.esc(value || '') + '"></div></div>' +
        '<div class="modal-actions"><button class="btn" data-x="no">취소</button>' +
        '<button class="btn btn-primary" data-x="ok">확인</button></div>'
      );
      const input = $('#pm-input', m);
      input.focus(); input.select();
      const ok = () => { const v = input.value.trim(); m.remove(); res(v || null); };
      $('[data-x="ok"]', m).onclick = ok;
      input.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
      $('[data-x="no"]', m).onclick = () => { m.remove(); res(null); };
    });
  }

  function speakerName(note, idx) {
    const sp = (note.speakers || [])[idx];
    return (sp && sp.name) || ('참석자 ' + ((idx || 0) + 1));
  }
  function speakerColor(idx) { return COLORS[(idx || 0) % COLORS.length]; }

  function noteText(note) {
    return (note.segments || []).map(s => s.text || '').join(' ');
  }

  const LANG_LABEL = { 'ko-KR': '한국어', 'en-US': '영어', 'ja-JP': '일본어', 'zh-CN': '중국어' };

  async function refresh() {
    S.notes = await VN.db.getAllNotes();
    S.folders = await VN.db.getFolders();
  }

  async function saveNote(note) { await VN.db.saveNote(note); }

  /* ── 전역 검색 (순수 함수: 셀프테스트에서 사용) ── */
  function searchNotes(notes, q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return notes.map(n => ({ note: n, snippet: null }));
    const out = [];
    for (const n of notes) {
      let snippet = null;
      const inTitle = (n.title || '').toLowerCase().includes(q);
      const seg = (n.segments || []).find(s => (s.text || '').toLowerCase().includes(q));
      const memo = (n.memos || []).find(m => (m.text || '').toLowerCase().includes(q));
      const src = seg ? seg.text : (memo ? memo.text : null);
      if (src) {
        const i = src.toLowerCase().indexOf(q);
        const from = Math.max(0, i - 30);
        snippet = (from > 0 ? '…' : '') + src.slice(from, i + q.length + 40) + (i + q.length + 40 < src.length ? '…' : '');
      }
      if (inTitle || src) out.push({ note: n, snippet });
    }
    return out;
  }

  /* ── 노트 내 찾아 바꾸기 (순수 함수) ── */
  function replaceInNote(note, find, repl) {
    if (!find) return 0;
    const re = new RegExp(U.escRegExp(find), 'gi');
    let count = 0;
    for (const s of (note.segments || [])) {
      const matches = (s.text || '').match(re);
      if (matches) { count += matches.length; s.text = s.text.replace(re, repl); }
    }
    return count;
  }

  function markText(text, q) {
    text = String(text || '');
    if (!q) return U.esc(text);
    const re = new RegExp('(' + U.escRegExp(q) + ')', 'gi');
    // 캡처 그룹 split → 홀수 인덱스가 매치 부분
    return text.split(re).map((part, i) => i % 2 ? '<mark>' + U.esc(part) + '</mark>' : U.esc(part)).join('');
  }

  /* ── Wake Lock (화면 켜짐 유지 — visible 상태에서만 획득 가능) ── */
  let wakeLockSentinel = null;
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { wakeLockSentinel = await navigator.wakeLock.request('screen'); } catch (e) { /* 탭이 숨김 상태면 실패 — 복귀 시 재시도 */ }
  }
  function releaseWakeLock() {
    if (wakeLockSentinel) { try { wakeLockSentinel.release(); } catch (e) { /* ignore */ } wakeLockSentinel = null; }
  }

  /* ── 상단 고정 배너 (복구·Drive 권한 재승인 등) ── */
  function showTopBanner(text, actions) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999;background:var(--green,#03C75A);color:#fff;' +
      'padding:10px 14px;display:flex;gap:10px;align-items:center;font-size:14px;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    const span = document.createElement('span');
    span.textContent = text;
    span.style.flex = '1';
    bar.appendChild(span);
    for (const a of (actions || [])) {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.style.cssText = 'padding:6px 14px;border-radius:8px;border:none;cursor:pointer;font-weight:700;' +
        (a.primary ? 'background:#fff;color:#02A94D' : 'background:rgba(255,255,255,.25);color:#fff');
      b.onclick = async () => { bar.remove(); if (a.onClick) await a.onClick(); };
      bar.appendChild(b);
    }
    document.body.appendChild(bar);
    return bar;
  }

  /* ── 크래시 세이프: 잔존 녹음 세션 복구 ── */
  async function checkRecovery() {
    let meta = null;
    try { meta = await VN.db.get('recChunks', 'meta'); } catch (e) { return; }
    if (!meta) return;
    showTopBanner('지난 녹음이 정상 종료되지 않았습니다 (' + U.fmtTime(meta.elapsed || 0) + ' 분량). 복구할까요?', [
      { label: '지난 녹음 복구', primary: true, onClick: () => recoverSession(meta) },
      { label: '삭제', onClick: async () => { await VN.db.clear('recChunks'); toast('복구 데이터를 삭제했습니다.'); } }
    ]);
  }

  async function recoverSession(meta) {
    try {
      const all = await VN.db.getAll('recChunks');
      const blob = VN.recorder.assembleChunks(all.filter(r => r.id !== 'meta'));
      const d = new Date(meta.updatedAt || Date.now());
      const note = VN.db.newNote({
        title: (d.getMonth() + 1) + '월 ' + d.getDate() + '일 복구된 녹음',
        language: meta.lang || 'ko-KR',
        duration: meta.elapsed || 0,
        audioBlob: blob.size ? blob : null,
        audioType: meta.mimeType || 'audio/webm',
        sourceType: 'record',
        speakers: meta.speakers || [{ name: '참석자 1' }],
        segments: meta.segments || [],
        memos: meta.memos || [],
        bookmarks: meta.bookmarks || []
      });
      await VN.db.saveNote(note);
      await VN.db.clear('recChunks');
      toast('지난 녹음을 복구했습니다.');
      go('#/note/' + note.id);
    } catch (e) { toast('복구 실패: ' + (e.message || e)); }
  }

  /* ── Drive 폴더 권한 재승인 배너 ── */
  async function checkDrivePermission() {
    try {
      const st = await VN.drive.getFolderStatus();
      if (st.supported && st.name && st.permission === 'prompt') {
        showTopBanner('Drive 저장 폴더("' + st.name + '") 접근 재승인이 필요합니다.', [
          {
            label: '재승인', primary: true, onClick: async () => {
              const p = await VN.drive.requestFolderPermission();
              toast(p === 'granted' ? '폴더 접근이 승인되었습니다.' : '승인되지 않았습니다. 설정에서 다시 시도하세요.');
            }
          }
        ]);
      }
    } catch (e) { /* ignore */ }
  }

  /* ══════════════ 라우팅 ══════════════ */

  async function route() {
    // 플레이어 정리 (objectURL 누수 방지)
    if (S.player) { S.player.destroy(); S.player = null; }
    // 녹음 중 이탈 → 자동 저장
    if (S.rec && S.rec.active && !location.hash.startsWith('#/record')) {
      await finishRecording(true);
      toast('진행 중이던 녹음을 저장했습니다.');
    }
    $('#app').classList.remove('sidebar-open');

    const hash = location.hash || '#/list';
    const parts = hash.slice(2).split('/');
    await refresh();
    renderSidebar(hash);

    if (parts[0] === 'note' && parts[1]) await viewNote(parts[1]);
    else if (parts[0] === 'record') viewRecord();
    else if (parts[0] === 'settings') await viewSettings();
    else if (parts[0] === 'trash') await viewTrash();
    else if (parts[0] === 'folder' && parts[1]) viewList({ folderId: parts[1] });
    else if (parts[0] === 'fav') viewList({ favorite: true });
    else viewList({});
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /* ══════════════ 사이드바 ══════════════ */

  function renderSidebar(hash) {
    const nav = $('#sidebar-nav');
    const counts = { all: S.notes.length, fav: S.notes.filter(n => n.favorite).length };
    const folderCount = (id) => S.notes.filter(n => n.folderId === id).length;
    let html = '';
    const item = (h, icon, label, count) =>
      '<button class="nav-item' + (hash === h || (h === '#/list' && (hash === '' || hash === '#' || hash === '#/list')) ? ' active' : '') +
      '" data-go="' + h + '">' + icon + ' ' + U.esc(label) +
      (count != null ? '<span class="count">' + count + '</span>' : '') + '</button>';
    html += item('#/list', '📄', '전체 노트', counts.all);
    html += item('#/fav', '⭐', '즐겨찾기', counts.fav);
    html += '<div class="nav-section"><span>폴더</span><button id="btn-add-folder" title="새 폴더">＋</button></div>';
    for (const f of S.folders) {
      html += item('#/folder/' + f.id, '📁', f.name, folderCount(f.id));
    }
    html += '<div class="nav-section"><span>관리</span></div>';
    html += item('#/trash', '🗑️', '휴지통');
    html += item('#/settings', '⚙️', '설정');
    nav.innerHTML = html;
    $$('.nav-item', nav).forEach(b => b.onclick = () => go(b.dataset.go));
    $('#btn-add-folder').onclick = async () => {
      const name = await promptModal('새 폴더', '폴더 이름', '');
      if (!name) return;
      await VN.db.saveFolder({ name });
      await refresh(); renderSidebar(location.hash);
      toast('폴더를 만들었습니다.');
    };
    updateStorageInfo();
  }

  async function updateStorageInfo() {
    const el = $('#storage-info');
    if (!el) return;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const used = (est.usage / 1024 / 1024).toFixed(1);
        const quota = (est.quota / 1024 / 1024 / 1024).toFixed(1);
        el.textContent = '저장 용량 ' + used + 'MB / ' + quota + 'GB';
      } catch (e) { el.textContent = ''; }
    }
  }

  /* ══════════════ 노트 리스트 ══════════════ */

  function sortNotes(notes) {
    const arr = notes.slice();
    if (S.sort === 'title') arr.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
    else if (S.sort === 'duration') arr.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    else arr.sort((a, b) => b.createdAt - a.createdAt);
    return arr;
  }

  function viewList(opts) {
    const folder = opts.folderId ? S.folders.find(f => f.id === opts.folderId) : null;
    let notes = S.notes;
    if (opts.folderId) notes = notes.filter(n => n.folderId === opts.folderId);
    if (opts.favorite) notes = notes.filter(n => n.favorite);

    const title = folder ? folder.name : (opts.favorite ? '즐겨찾기' : '전체 노트');
    let html = '<div class="view"><div class="view-header">' +
      '<h1>' + U.esc(title) + '</h1>';
    if (folder) {
      html += '<button class="icon-btn" id="btn-folder-rename" title="이름 변경">✏️</button>' +
        '<button class="icon-btn" id="btn-folder-del" title="폴더 삭제">🗑️</button>';
    }
    html += '<div class="spacer"></div>' +
      '<div class="searchbar"><input type="search" id="list-search" placeholder="노트 검색 (제목·본문·메모)" value="' + U.esc(S.listQuery) + '"></div>' +
      '<select id="list-sort">' +
      '<option value="recent"' + (S.sort === 'recent' ? ' selected' : '') + '>최신순</option>' +
      '<option value="title"' + (S.sort === 'title' ? ' selected' : '') + '>제목순</option>' +
      '<option value="duration"' + (S.sort === 'duration' ? ' selected' : '') + '>길이순</option>' +
      '</select></div><div id="note-list"></div></div>';
    main().innerHTML = html;

    const renderCards = () => {
      const q = S.listQuery.trim();
      const results = searchNotes(sortNotes(notes), q);
      const list = $('#note-list');
      if (!results.length) {
        list.innerHTML = '<div class="empty-state"><div class="big">🎙️</div>' +
          (q ? '검색 결과가 없습니다.' : '노트가 없습니다.<br>새 녹음을 시작하거나 오디오 파일을 끌어다 놓아 보세요.') + '</div>';
        return;
      }
      list.innerHTML = results.map(({ note: n, snippet }) => {
        const preview = q && snippet ? markText(snippet, q) : U.esc(noteText(n).slice(0, 120) || '(전사 없음)');
        const fname = n.folderId ? (S.folders.find(f => f.id === n.folderId) || {}).name : null;
        return '<button class="note-card" data-id="' + n.id + '">' +
          '<div class="nc-title">' + (n.favorite ? '<span class="star">★</span>' : '') + markText(n.title || '제목 없음', q) + '</div>' +
          '<div class="nc-preview">' + preview + '</div>' +
          '<div class="nc-meta"><span>' + U.fmtDate(n.createdAt) + '</span><span>⏱ ' + U.fmtTime(n.duration) + '</span>' +
          (fname ? '<span>📁 ' + U.esc(fname) + '</span>' : '') +
          (n.tags || []).map(t => '<span class="tag green">#' + U.esc(t) + '</span>').join('') +
          (n.audioBlob ? '' : '<span class="tag">오디오 없음</span>') +
          '</div></button>';
      }).join('');
      $$('.note-card', list).forEach(c => c.onclick = () => {
        if (S.listQuery.trim()) S.pendingJump = S.listQuery.trim();
        go('#/note/' + c.dataset.id);
      });
    };
    renderCards();

    $('#list-search').oninput = U.debounce((e) => { S.listQuery = e.target.value; renderCards(); }, 200);
    $('#list-sort').onchange = (e) => { S.sort = e.target.value; renderCards(); };

    if (folder) {
      $('#btn-folder-rename').onclick = async () => {
        const name = await promptModal('폴더 이름 변경', '폴더 이름', folder.name);
        if (!name) return;
        folder.name = name;
        await VN.db.saveFolder(folder);
        route();
      };
      $('#btn-folder-del').onclick = async () => {
        if (await confirmModal('폴더 삭제', '폴더를 삭제하면 안의 노트는 전체 노트로 이동합니다.', '삭제', true)) {
          await VN.db.deleteFolder(folder.id);
          go('#/list');
        }
      };
    }
  }

  /* ══════════════ 노트 상세 ══════════════ */

  async function viewNote(id) {
    const note = await VN.db.getNote(id);
    if (!note) { toast('노트를 찾을 수 없습니다.'); go('#/list'); return; }
    S.note = note;
    S.noteTab = 'seg';
    S.segFilter = 'all';
    S.noteSearch = { q: '', matches: [], cur: -1 };
    S.editingSeg = null;

    const hasAudio = note.audioBlob instanceof Blob;
    let html = '<div class="view">' +
      '<div class="note-title-row">' +
      '<button class="icon-btn" id="btn-back" title="목록으로">←</button>' +
      '<input class="note-title-input" id="note-title" value="' + U.esc(note.title) + '">' +
      '<button class="icon-btn' + (note.favorite ? ' on' : '') + '" id="btn-fav" title="즐겨찾기">' + (note.favorite ? '★' : '☆') + '</button>' +
      '<button class="icon-btn" id="btn-share" title="공유">↗</button>' +
      '<button class="icon-btn" id="btn-export" title="다운로드">⬇</button>' +
      '<button class="icon-btn" id="btn-drive-save" title="Drive 저장">☁</button>' +
      '<button class="icon-btn" id="btn-cal" title="📅 일정 연결">📅</button>' +
      (hasAudio ? '<button class="icon-btn" id="btn-regem" title="오디오 전체 재변환">🎤</button>' : '') +
      '<button class="icon-btn" id="btn-del-note" title="삭제">🗑</button>' +
      '</div>' +
      '<div class="note-info">' +
      '<span>' + U.fmtDate(note.createdAt) + '</span>' +
      '<span>⏱ ' + U.fmtTime(note.duration) + '</span>' +
      '<span>' + (LANG_LABEL[note.language] || note.language || '-') + '</span>' +
      (note.tags || []).map(t => '<span class="tag green">#' + U.esc(t) + '</span>').join('') +
      (note.calendar && note.calendar.title ? '<span title="연결된 일정">📅 ' + U.esc(note.calendar.title) + '</span>' : '') +
      (note.driveLink ? '<span><a href="' + U.esc(note.driveLink) + '" target="_blank" rel="noopener">Drive에서 열기 ↗</a></span>' : '') +
      '<span>📁 <select id="note-folder"><option value="">전체 노트</option>' +
      S.folders.map(f => '<option value="' + f.id + '"' + (note.folderId === f.id ? ' selected' : '') + '>' + U.esc(f.name) + '</option>').join('') +
      '</select></span>' +
      '</div>';

    if (hasAudio) {
      html += '<div class="player-bar">' +
        '<canvas class="player-wave" id="pl-wave"></canvas>' +
        '<div class="player-controls">' +
        '<button class="btn-play" id="pl-toggle">▶</button>' +
        '<button class="icon-btn" id="pl-back10" title="10초 뒤로">⟲10</button>' +
        '<button class="icon-btn" id="pl-fwd10" title="10초 앞으로">10⟳</button>' +
        '<button class="icon-btn" id="pl-speed" title="배속">1.0×</button>' +
        '<button class="icon-btn" id="pl-ab" title="A-B 구간 반복">A-B</button>' +
        '<span class="player-time" id="pl-time">00:00 / ' + U.fmtTime(note.duration) + '</span>' +
        '<button class="icon-btn" id="pl-dl-audio" title="원본 오디오 다운로드">🎵⬇</button>' +
        '</div></div>';
      html += '<audio id="note-audio" preload="metadata" style="display:none"></audio>';
    } else {
      html += '<div class="banner info">이 노트에는 오디오가 없습니다.</div>';
    }

    // 참석자 + 발화 비율
    html += '<details class="ai-block" style="margin-bottom:12px"><summary style="cursor:pointer;font-weight:600">참석자 · 발화 비율</summary>' +
      '<div id="speaker-panel"></div></details>';

    html += '<div class="tabs">' +
      '<button class="tab active" data-tab="seg">음성 기록</button>' +
      '<button class="tab" data-tab="memo">메모 <span class="faint">' + (note.memos || []).length + '</span></button>' +
      '<button class="tab" data-tab="ai">AI 요약</button>' +
      '</div><div id="tab-body"></div></div>';

    main().innerHTML = html;

    /* 헤더 이벤트 */
    $('#btn-back').onclick = () => go('#/list');
    $('#note-title').onchange = async (e) => { note.title = e.target.value.trim() || '제목 없음'; await saveNote(note); };
    $('#btn-fav').onclick = async (e) => {
      note.favorite = !note.favorite;
      await saveNote(note);
      e.target.classList.toggle('on', note.favorite);
      e.target.textContent = note.favorite ? '★' : '☆';
    };
    $('#note-folder').onchange = async (e) => { note.folderId = e.target.value || null; await saveNote(note); toast('폴더를 이동했습니다.'); };
    $('#btn-del-note').onclick = async () => {
      if (await confirmModal('노트 삭제', '휴지통으로 이동합니다. 30일 후 자동으로 영구 삭제됩니다.', '삭제', true)) {
        if (S.player) { S.player.destroy(); S.player = null; }
        await VN.db.trashNote(note.id);
        toast('휴지통으로 이동했습니다.');
        go('#/list');
      }
    };
    $('#btn-share').onclick = () => shareModal(note);
    $('#btn-export').onclick = () => exportModal(note);
    $('#btn-drive-save').onclick = async () => {
      const b = $('#btn-drive-save');
      b.disabled = true;
      toast('Drive 저장 중…');
      try {
        const r = await VN.drive.saveNoteToDrive(note);
        toast(r.message || (r.saved ? 'Drive에 저장했습니다.' : 'Drive 저장을 건너뛰었습니다.'));
        if (r.titleChanged && $('#note-title')) $('#note-title').value = note.title;
      } catch (e) { toast('Drive 저장 실패: ' + (e.message || e)); }
      b.disabled = false;
    };
    if ($('#btn-regem')) $('#btn-regem').onclick = () => retranscribeModal(note);
    /* 일정 연결 — 로그인/권한 없으면 조용히 버튼을 숨긴다 */
    $('#btn-cal').onclick = () => calendarLinkModal(note);
    VN.gcal.available().then(ok => {
      const b = $('#btn-cal');
      if (b && !ok) b.remove();
    }).catch(() => { const b = $('#btn-cal'); if (b) b.remove(); });

    /* 플레이어 */
    if (hasAudio) {
      const audioEl = $('#note-audio');
      S.player = VN.player.create(audioEl, note, {
        onTime: (t) => {
          $('#pl-time') && ($('#pl-time').textContent = U.fmtTime(t) + ' / ' + U.fmtTime(S.player.duration));
          syncCurrentSegment(t);
        },
        onEnded: () => { const b = $('#pl-toggle'); if (b) b.textContent = '▶'; }
      });
      S.player.bindWave($('#pl-wave'));
      $('#pl-toggle').onclick = () => {
        S.player.toggle();
        $('#pl-toggle').textContent = S.player.paused ? '▶' : '⏸';
      };
      audioEl.addEventListener('play', () => { $('#pl-toggle') && ($('#pl-toggle').textContent = '⏸'); });
      audioEl.addEventListener('pause', () => { $('#pl-toggle') && ($('#pl-toggle').textContent = '▶'); });
      $('#pl-back10').onclick = () => S.player.skip(-10);
      $('#pl-fwd10').onclick = () => S.player.skip(10);
      $('#pl-speed').onclick = () => { $('#pl-speed').textContent = S.player.cycleSpeed().toFixed(2).replace(/0$/, '') + '×'; };
      $('#pl-ab').onclick = () => {
        const st = S.player.toggleAB();
        const b = $('#pl-ab');
        if (st === 'A') { b.textContent = 'A-?'; b.classList.add('on'); toast('반복 시작 지점(A)을 설정했습니다.'); }
        else if (st === 'B') { b.textContent = 'A-B'; b.classList.add('on'); toast('A-B 구간 반복을 시작합니다.'); }
        else { b.textContent = 'A-B'; b.classList.remove('on'); toast('구간 반복을 해제했습니다.'); }
      };
      $('#pl-dl-audio').onclick = () => {
        const ext = (note.audioBlob.type || '').includes('wav') ? 'wav' : (note.audioBlob.type || '').includes('mp4') ? 'm4a' : (note.audioBlob.type || '').includes('mpeg') ? 'mp3' : 'webm';
        VN.exporter.download(VN.exporter.safeName(note.title) + '.' + ext, note.audioBlob);
      };
    }

    renderSpeakerPanel(note);

    $$('.tab').forEach(t => t.onclick = () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      S.noteTab = t.dataset.tab;
      renderTabBody(note);
    });
    renderTabBody(note);

    // 전역 검색에서 온 점프
    if (S.pendingJump) {
      const q = S.pendingJump; S.pendingJump = null;
      S.noteSearch.q = q;
      renderTabBody(note);
      setTimeout(() => jumpToMatch(0), 100);
    }
  }

  /* ── 참석자 패널: 이름 변경/병합 + 발화 비율 차트(SVG) ── */
  function renderSpeakerPanel(note) {
    const panel = $('#speaker-panel');
    if (!panel) return;
    const used = new Set((note.segments || []).map(s => s.speaker || 0));
    if (!(note.speakers || []).length) note.speakers = [{ name: '참석자 1' }];
    const totals = {};
    let grand = 0;
    for (const s of (note.segments || [])) {
      const d = Math.max(0.5, (s.end || s.start) - s.start);
      totals[s.speaker || 0] = (totals[s.speaker || 0] || 0) + d;
      grand += d;
    }
    const idxs = [...used].sort((a, b) => a - b);
    let legend = '<div class="speaker-legend">';
    for (const i of idxs) {
      legend += '<span class="sp"><span class="sp-dot" style="background:' + speakerColor(i) + '"></span>' +
        U.esc(speakerName(note, i)) + ' <span class="faint">' + (grand ? Math.round((totals[i] || 0) / grand * 100) : 0) + '%</span></span>';
    }
    legend += '<button class="btn btn-sm btn-outline" id="btn-speakers-edit">이름 변경·병합</button></div>';

    // 발화 비율 가로 막대 SVG
    let svg = '';
    if (grand > 0 && idxs.length) {
      const W = 560, BH = 22, GAP = 8;
      const H = idxs.length * (BH + GAP);
      svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:560px;margin-top:10px" role="img" aria-label="참석자별 발화 비율">';
      idxs.forEach((i, r) => {
        const pct = (totals[i] || 0) / grand;
        const y = r * (BH + GAP);
        svg += '<rect x="0" y="' + y + '" width="' + W + '" height="' + BH + '" rx="5" fill="var(--bg-hover)"/>' +
          '<rect x="0" y="' + y + '" width="' + Math.max(4, pct * W) + '" height="' + BH + '" rx="5" fill="' + speakerColor(i) + '"/>' +
          '<text x="8" y="' + (y + BH - 7) + '" font-size="11" fill="#fff" font-weight="700">' + U.esc(speakerName(note, i)) + ' ' + Math.round(pct * 100) + '%</text>';
      });
      svg += '</svg>';
    }
    panel.innerHTML = legend + svg;

    $('#btn-speakers-edit').onclick = () => {
      const rows = idxs.map(i =>
        '<div class="settings-row" data-idx="' + i + '">' +
        '<span class="sp-dot" style="background:' + speakerColor(i) + '"></span>' +
        '<input type="text" class="sp-name" value="' + U.esc(speakerName(note, i)) + '" style="flex:1;min-width:100px">' +
        '<select class="sp-merge"><option value="">병합 안 함</option>' +
        idxs.filter(j => j !== i).map(j => '<option value="' + j + '">→ ' + U.esc(speakerName(note, j)) + '에 병합</option>').join('') +
        '</select></div>'
      ).join('');
      const m = modal('<h2>참석자 이름 변경 · 병합</h2><div class="modal-body">' + rows +
        '<p class="muted small">병합하면 해당 참석자의 모든 발화가 대상 참석자로 합쳐집니다.</p></div>' +
        '<div class="modal-actions"><button class="btn" data-x="no">취소</button><button class="btn btn-primary" data-x="ok">저장</button></div>');
      $('[data-x="no"]', m).onclick = () => m.remove();
      $('[data-x="ok"]', m).onclick = async () => {
        // 이름 일괄 변경
        $$('.settings-row', m).forEach(row => {
          const i = +row.dataset.idx;
          const name = $('.sp-name', row).value.trim();
          if (!note.speakers[i]) note.speakers[i] = {};
          if (name) note.speakers[i].name = name;
        });
        // 병합
        $$('.settings-row', m).forEach(row => {
          const from = +row.dataset.idx;
          const to = $('.sp-merge', row).value;
          if (to !== '') {
            for (const s of (note.segments || [])) if ((s.speaker || 0) === from) s.speaker = +to;
          }
        });
        await saveNote(note);
        m.remove();
        renderSpeakerPanel(note);
        renderTabBody(note);
        toast('참석자 정보를 저장했습니다.');
      };
    };
  }

  /* ── 탭 본문 ── */
  function renderTabBody(note) {
    if (S.noteTab === 'seg') renderSegTab(note);
    else if (S.noteTab === 'memo') renderMemoTab(note);
    else renderAiTab(note);
  }

  /* ── 음성 기록 탭 ── */
  function visibleSegments(note) {
    let segs = (note.segments || []).map((s, i) => ({ s, i }));
    if (S.segFilter === 'bookmark') segs = segs.filter(x => x.s.bookmarked);
    if (S.segFilter === 'highlight') segs = segs.filter(x => x.s.highlighted);
    return segs;
  }

  function renderSegTab(note) {
    const body = $('#tab-body');
    let html = '<div class="seg-toolbar">' +
      '<button class="filter-chip' + (S.segFilter === 'all' ? ' on' : '') + '" data-f="all">전체</button>' +
      '<button class="filter-chip' + (S.segFilter === 'bookmark' ? ' on' : '') + '" data-f="bookmark">🔖 북마크만</button>' +
      '<button class="filter-chip' + (S.segFilter === 'highlight' ? ' on' : '') + '" data-f="highlight">🖍 하이라이트만</button>' +
      '<div class="spacer" style="flex:1"></div>' +
      '<button class="btn btn-sm btn-outline" id="btn-add-seg">＋ 구간 추가</button>' +
      '</div>' +
      '<div class="note-search-bar">' +
      '<input type="search" id="ns-q" placeholder="노트 내 검색" value="' + U.esc(S.noteSearch.q) + '">' +
      '<button class="icon-btn" id="ns-prev" title="이전">↑</button>' +
      '<button class="icon-btn" id="ns-next" title="다음">↓</button>' +
      '<span class="match-info" id="ns-info"></span>' +
      '<input type="text" id="ns-repl" placeholder="바꿀 내용">' +
      '<button class="btn btn-sm" id="ns-replace">한 번에 바꾸기</button>' +
      '</div>';

    // 녹음 중 찍은 시점 북마크 칩
    if ((note.bookmarks || []).length) {
      html += '<div class="bm-chips">' + note.bookmarks.map(b =>
        '<button class="filter-chip" data-bm-time="' + b.time + '">🔖 ' + U.fmtTime(b.time) + '</button>').join('') + '</div>';
    }

    html += '<div id="seg-list"></div>';
    body.innerHTML = html;

    renderSegList(note);

    $$('.filter-chip[data-f]', body).forEach(c => c.onclick = () => { S.segFilter = c.dataset.f; renderSegTab(note); });
    $$('[data-bm-time]', body).forEach(c => c.onclick = () => { if (S.player) S.player.playFrom(+c.dataset.bmTime); });

    $('#btn-add-seg').onclick = async () => {
      const t = S.player ? S.player.currentTime : ((note.segments.slice(-1)[0] || {}).end || 0);
      note.segments.push({ id: U.uid(), speaker: 0, start: t, end: t + 3, text: '', bookmarked: false, highlighted: false });
      note.segments.sort((a, b) => a.start - b.start);
      await saveNote(note);
      renderSegTab(note);
      // 새 구간 바로 편집
      const idx = note.segments.findIndex(s => s.text === '' );
      if (idx >= 0) startEditSegment(note, idx);
    };

    const doSearch = () => {
      const q = $('#ns-q').value;
      S.noteSearch.q = q;
      S.noteSearch.matches = [];
      if (q.trim()) {
        note.segments.forEach((s, i) => {
          if ((s.text || '').toLowerCase().includes(q.trim().toLowerCase())) S.noteSearch.matches.push(i);
        });
      }
      S.noteSearch.cur = S.noteSearch.matches.length ? 0 : -1;
      renderSegList(note);
      updateMatchInfo();
    };
    $('#ns-q').oninput = U.debounce(doSearch, 250);
    $('#ns-prev').onclick = () => jumpToMatch(-1);
    $('#ns-next').onclick = () => jumpToMatch(1);
    $('#ns-replace').onclick = async () => {
      const find = $('#ns-q').value.trim();
      const repl = $('#ns-repl').value;
      if (!find) { toast('바꿀 검색어를 입력하세요.'); return; }
      const n = replaceInNote(note, find, repl);
      if (n > 0) { await saveNote(note); toast(n + '건을 바꿨습니다.'); doSearch(); }
      else toast('일치하는 내용이 없습니다.');
    };
    if (S.noteSearch.q) doSearch();
  }

  function updateMatchInfo() {
    const el = $('#ns-info');
    if (!el) return;
    const m = S.noteSearch;
    el.textContent = m.matches.length ? ((m.cur + 1) + ' / ' + m.matches.length) : (m.q ? '0건' : '');
  }

  function jumpToMatch(dir) {
    const m = S.noteSearch;
    if (!m.matches.length) return;
    if (dir === 0) m.cur = 0;
    else m.cur = (m.cur + dir + m.matches.length) % m.matches.length;
    updateMatchInfo();
    const segIdx = m.matches[m.cur];
    const el = $('[data-seg-idx="' + segIdx + '"]');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }

  function renderSegList(note) {
    const list = $('#seg-list');
    if (!list) return;
    const segs = visibleSegments(note);
    if (!segs.length) {
      list.innerHTML = '<div class="empty-state">표시할 내용이 없습니다.' +
        (S.segFilter !== 'all' ? '<br><span class="small">필터를 해제해 보세요.</span>' : '<br><span class="small">"구간 추가"로 직접 전사를 입력할 수 있습니다.</span>') + '</div>';
      return;
    }
    const q = S.noteSearch.q.trim();
    list.innerHTML = segs.map(({ s, i }) => {
      const name = speakerName(note, s.speaker);
      return '<div class="segment' + (s.highlighted ? ' hl' : '') + '" data-seg-idx="' + i + '">' +
        '<div class="seg-avatar" style="background:' + speakerColor(s.speaker) + '">' + U.esc(name.slice(0, 2)) + '</div>' +
        '<div class="seg-body"><div class="seg-head">' +
        '<span>' + U.esc(name) + '</span>' +
        '<span class="seg-time" data-t="' + s.start + '" title="이 지점부터 재생">' + U.fmtTime(s.start) + '</span>' +
        '<span class="seg-actions">' +
        '<button data-act="bm" class="' + (s.bookmarked ? 'on' : '') + '" title="북마크">' + (s.bookmarked ? '🔖' : '📑') + '</button>' +
        '<button data-act="hl" class="' + (s.highlighted ? 'on' : '') + '" title="하이라이트">🖍</button>' +
        '<button data-act="edit" title="편집">✎</button>' +
        '<button data-act="del" title="삭제">🗑</button>' +
        '</span></div>' +
        '<div class="seg-text" data-text-idx="' + i + '">' + (q ? markText(s.text || '', q) : U.esc(s.text || '')) + '</div>' +
        '</div></div>';
    }).join('');

    $$('.seg-time', list).forEach(el => el.onclick = () => { if (S.player) S.player.playFrom(+el.dataset.t); });
    $$('.segment', list).forEach(row => {
      const i = +row.dataset.segIdx;
      const s = note.segments[i];
      $$('button[data-act]', row).forEach(b => b.onclick = async (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'bm') { s.bookmarked = !s.bookmarked; await saveNote(note); renderSegList(note); }
        else if (act === 'hl') { s.highlighted = !s.highlighted; await saveNote(note); renderSegList(note); }
        else if (act === 'edit') startEditSegment(note, i);
        else if (act === 'del') {
          if (await confirmModal('구간 삭제', '이 구간을 삭제할까요?', '삭제', true)) {
            note.segments.splice(i, 1);
            await saveNote(note);
            renderSegTab(note);
          }
        }
      });
    });
  }

  function startEditSegment(note, idx) {
    const el = $('[data-text-idx="' + idx + '"]');
    if (!el) return;
    el.textContent = note.segments[idx].text || '';
    el.contentEditable = 'true';
    el.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(el);
    sel.collapseToEnd();
    const finish = async () => {
      el.contentEditable = 'false';
      note.segments[idx].text = el.textContent.trim();
      await saveNote(note);
      renderSegList(note);
    };
    el.onblur = finish;
    el.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); } };
  }

  /* 재생 동기: 현재 세그먼트 하이라이트 + 자동 스크롤 */
  let lastCurrentIdx = -1;
  function syncCurrentSegment(t) {
    if (S.noteTab !== 'seg' || !S.note) return;
    const segs = S.note.segments || [];
    let cur = -1;
    for (let i = 0; i < segs.length; i++) {
      if (t >= segs[i].start && t < (segs[i].end || segs[i].start + 2)) { cur = i; break; }
    }
    if (cur === lastCurrentIdx) return;
    lastCurrentIdx = cur;
    $$('.segment.current').forEach(el => el.classList.remove('current'));
    if (cur >= 0) {
      const el = $('[data-seg-idx="' + cur + '"]');
      if (el) {
        el.classList.add('current');
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  /* ── 메모 탭 ── */
  function renderMemoTab(note) {
    const body = $('#tab-body');
    const curT = S.player ? S.player.currentTime : 0;
    let html = '<div class="record-memo-row" style="margin-bottom:14px">' +
      '<input type="text" id="memo-new" placeholder="메모 입력 후 Enter (현재 재생 시점 기준으로 기록)">' +
      '<button class="btn btn-primary btn-sm" id="memo-add">추가</button></div>' +
      '<div id="memo-list"></div>';
    body.innerHTML = html;

    const renderList = () => {
      const list = $('#memo-list');
      const memos = (note.memos || []).slice().sort((a, b) => a.time - b.time);
      if (!memos.length) { list.innerHTML = '<div class="empty-state">메모가 없습니다.</div>'; return; }
      list.innerHTML = memos.map(m =>
        '<div class="memo-item" data-mid="' + m.id + '">' +
        '<span class="memo-time" data-t="' + m.time + '" title="이 시점 재생">' + U.fmtTime(m.time) + '</span>' +
        '<div class="memo-text" data-medit="' + m.id + '">' + U.esc(m.text) + '</div>' +
        '<button class="icon-btn" data-mdel="' + m.id + '" title="삭제">🗑</button>' +
        '</div>').join('');
      $$('.memo-time', list).forEach(el => el.onclick = () => { if (S.player) S.player.playFrom(+el.dataset.t); });
      $$('[data-mdel]', list).forEach(b => b.onclick = async () => {
        note.memos = note.memos.filter(m => m.id !== b.dataset.mdel);
        await saveNote(note);
        renderList();
      });
      $$('[data-medit]', list).forEach(el => el.onclick = () => {
        if (el.contentEditable === 'true') return;
        el.contentEditable = 'true';
        el.focus();
        el.onblur = async () => {
          el.contentEditable = 'false';
          const m = note.memos.find(x => x.id === el.dataset.medit);
          if (m) { m.text = el.textContent.trim(); await saveNote(note); }
        };
      });
    };
    renderList();

    const add = async () => {
      const v = $('#memo-new').value.trim();
      if (!v) return;
      note.memos.push({ id: U.uid(), time: S.player ? S.player.currentTime : 0, text: v, createdAt: Date.now() });
      $('#memo-new').value = '';
      await saveNote(note);
      renderList();
    };
    $('#memo-add').onclick = add;
    $('#memo-new').onkeydown = (e) => { if (e.key === 'Enter') add(); };
  }

  /* ── AI 요약 탭 ── */
  function renderAiTab(note) {
    const body = $('#tab-body');
    const s = note.summary;
    let html = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">' +
      '<button class="btn btn-primary" id="btn-ai-run">' + (s ? 'AI 정리 다시 생성' : 'AI 정리 생성') + '</button>' +
      '<span class="muted small" id="ai-mode-info"></span></div><div id="ai-result"></div>';
    body.innerHTML = html;
    VN.db.getSetting('geminiApiKey', '').then(k => {
      $('#ai-mode-info') && ($('#ai-mode-info').textContent = k ? '고급 모드(Gemini 2.5 Flash) (실패 시 기본 모드 폴백)' : '기본 모드 (오프라인 추출 요약)');
    });

    const renderResult = () => {
      const el = $('#ai-result');
      const sum = note.summary;
      if (!sum) { el.innerHTML = '<div class="empty-state">버튼을 눌러 요약·주요 주제·다음 할 일·키워드를 생성하세요.<br><span class="small">모든 결과는 클릭해서 편집할 수 있습니다.</span></div>'; return; }
      let h = '';
      if (sum.fallbackReason) h += '<div class="banner">' + U.esc(sum.fallbackReason) + '</div>';
      h += '<div class="ai-block"><h3><span class="dot"></span>요약 <span class="faint small">(' + (sum.mode === 'gemini' ? 'Gemini' : '기본') + ')</span></h3>' +
        '<div class="ai-editable" id="ai-summary" contenteditable="true">' + U.esc(sum.summary || '') + '</div></div>';
      h += '<div class="ai-block"><h3><span class="dot"></span>주요 주제</h3>' +
        ((sum.topics || []).length ? sum.topics.map((t, i) =>
          '<div style="margin-bottom:8px"><span class="seg-time memo-time" data-topic-t="' + (t.start || 0) + '">' + U.fmtTime(t.start || 0) + '</span> ' +
          '<b class="ai-editable" contenteditable="true" data-topic-title="' + i + '" style="display:inline-block">' + U.esc(t.title) + '</b>' +
          '<div class="ai-editable muted" contenteditable="true" data-topic-sum="' + i + '">' + U.esc(t.summary) + '</div></div>'
        ).join('') : '<div class="faint">추출된 주제가 없습니다.</div>') + '</div>';
      h += '<div class="ai-block"><h3><span class="dot"></span>다음 할 일</h3><ul id="ai-todos">' +
        ((sum.todos || []).length ? sum.todos.map((t, i) =>
          '<li><span class="ai-editable" contenteditable="true" data-todo="' + i + '">' + U.esc(t) + '</span> ' +
          '<button class="icon-btn btn-sm" data-todo-del="' + i + '" style="padding:1px 6px">✕</button></li>').join('') : '') +
        '</ul><button class="btn btn-sm btn-outline" id="ai-todo-add">＋ 항목 추가</button></div>';
      h += '<div class="ai-block"><h3><span class="dot"></span>키워드</h3><div id="ai-kws">' +
        (sum.keywords || []).map((k, i) => '<span class="kw-chip">#' + U.esc(k) + ' <a href="#" data-kw-del="' + i + '" style="text-decoration:none">✕</a></span>').join('') +
        '</div><div class="record-memo-row" style="margin-top:8px;max-width:260px"><input type="text" id="ai-kw-new" placeholder="키워드 추가">' +
        '<button class="btn btn-sm" id="ai-kw-add">추가</button></div></div>';
      el.innerHTML = h;

      /* 편집 저장 */
      $('#ai-summary').onblur = async () => { note.summary.summary = $('#ai-summary').textContent.trim(); await saveNote(note); };
      $$('[data-topic-title]', el).forEach(x => x.onblur = async () => { note.summary.topics[+x.dataset.topicTitle].title = x.textContent.trim(); await saveNote(note); });
      $$('[data-topic-sum]', el).forEach(x => x.onblur = async () => { note.summary.topics[+x.dataset.topicSum].summary = x.textContent.trim(); await saveNote(note); });
      $$('[data-topic-t]', el).forEach(x => x.onclick = () => { if (S.player) S.player.playFrom(+x.dataset.topicT); });
      $$('[data-todo]', el).forEach(x => x.onblur = async () => { note.summary.todos[+x.dataset.todo] = x.textContent.trim(); await saveNote(note); });
      $$('[data-todo-del]', el).forEach(x => x.onclick = async () => { note.summary.todos.splice(+x.dataset.todoDel, 1); await saveNote(note); renderResult(); });
      $('#ai-todo-add').onclick = async () => { note.summary.todos.push('새 할 일'); await saveNote(note); renderResult(); };
      $$('[data-kw-del]', el).forEach(x => x.onclick = async (e) => { e.preventDefault(); note.summary.keywords.splice(+x.dataset.kwDel, 1); await saveNote(note); renderResult(); });
      $('#ai-kw-add').onclick = async () => {
        const v = $('#ai-kw-new').value.trim();
        if (!v) return;
        note.summary.keywords.push(v);
        await saveNote(note); renderResult();
      };
    };
    renderResult();

    $('#btn-ai-run').onclick = async () => {
      if (!(note.segments || []).some(x => x.text && x.text.trim())) { toast('요약할 전사 텍스트가 없습니다.'); return; }
      const btn = $('#btn-ai-run');
      btn.disabled = true; btn.textContent = '생성 중…';
      try {
        note.summary = await VN.summarizer.run(note);
        await saveNote(note);
        renderResult();
        toast('AI 정리를 생성했습니다.');
      } catch (e) {
        toast('생성 실패: ' + (e.message || e));
      }
      btn.disabled = false; btn.textContent = 'AI 정리 다시 생성';
    };
  }

  /* ══════════════ 공유 / 다운로드 ══════════════ */

  function shareModal(note) {
    const hasAudio = note.audioBlob instanceof Blob;
    const m = modal('<h2>공유</h2><div class="modal-body">' +
      '<p class="muted small" style="margin-bottom:10px">보이스노트는 서버가 없는 로컬 앱이라 "링크 공유" 대신 파일·텍스트로 공유합니다.</p>' +
      '<button class="btn btn-block" id="sh-copy" style="margin-bottom:8px">📋 전체 텍스트 클립보드 복사</button>' +
      (navigator.share ? '<button class="btn btn-block" id="sh-web" style="margin-bottom:8px">📤 기기 공유 (Web Share)</button>' : '') +
      '<div class="ai-block" style="margin-top:6px"><h3>공유용 HTML 파일 만들기</h3>' +
      '<p class="muted small">받는 사람이 브라우저로 바로 열 수 있는 자체 뷰어가 담긴 단일 파일입니다.</p>' +
      '<div class="check-row"><input type="checkbox" id="sh-audio"' + (hasAudio ? '' : ' disabled') + '><label for="sh-audio">오디오 포함' + (hasAudio ? '' : ' (오디오 없음)') + '</label></div>' +
      '<div class="form-row"><label>비밀번호 (선택 — 설정 시 AES-GCM으로 암호화)</label><input type="password" id="sh-pw" placeholder="비워두면 암호화 안 함"></div>' +
      '<button class="btn btn-primary btn-block" id="sh-html">HTML 파일 내려받기</button></div>' +
      '</div><div class="modal-actions"><button class="btn" data-x="no">닫기</button></div>');
    $('[data-x="no"]', m).onclick = () => m.remove();
    $('#sh-copy', m).onclick = async () => {
      try {
        await navigator.clipboard.writeText(VN.exporter.toTXT(note, {}));
        toast('클립보드에 복사했습니다.');
      } catch (e) { toast('복사에 실패했습니다: ' + e.message); }
    };
    if ($('#sh-web', m)) $('#sh-web', m).onclick = async () => {
      try {
        await navigator.share({ title: note.title, text: VN.exporter.toTXT(note, {}).slice(0, 30000) });
      } catch (e) { /* 사용자가 취소한 경우 등 */ }
    };
    $('#sh-html', m).onclick = async () => {
      const btn = $('#sh-html', m);
      btn.disabled = true; btn.textContent = '만드는 중…';
      try {
        const html = await VN.exporter.toShareHTML(note, {
          includeAudio: $('#sh-audio', m).checked,
          password: $('#sh-pw', m).value || null
        });
        VN.exporter.download(VN.exporter.safeName(note.title) + '-공유.html', html, 'text/html;charset=utf-8');
        toast('공유용 HTML을 내려받았습니다.');
        m.remove();
      } catch (e) {
        toast('생성 실패: ' + (e.message || e));
        btn.disabled = false; btn.textContent = 'HTML 파일 내려받기';
      }
    };
  }

  function exportModal(note) {
    const hasAudio = note.audioBlob instanceof Blob;
    const m = modal('<h2>다운로드</h2><div class="modal-body">' +
      '<div class="form-row"><label>형식</label><select id="ex-fmt">' +
      '<option value="txt">TXT (텍스트)</option>' +
      '<option value="doc">DOC (Word 호환)</option>' +
      '<option value="srt">SRT (자막)</option>' +
      '<option value="vtt">VTT (웹 자막)</option>' +
      '<option value="json">JSON (전체 데이터)</option>' +
      (hasAudio ? '<option value="audio">원본 오디오</option>' : '') +
      '</select></div>' +
      '<div id="ex-opts">' +
      '<div class="check-row"><input type="checkbox" id="ex-sp" checked><label for="ex-sp">화자 이름 포함</label></div>' +
      '<div class="check-row"><input type="checkbox" id="ex-time" checked><label for="ex-time">시각 포함</label></div>' +
      '<div class="check-row"><input type="checkbox" id="ex-memo" checked><label for="ex-memo">메모 포함</label></div>' +
      '<div class="check-row hidden" id="ex-audio-row"><input type="checkbox" id="ex-audio"><label for="ex-audio">오디오 포함 (base64)</label></div>' +
      '</div></div>' +
      '<div class="modal-actions"><button class="btn" data-x="no">취소</button><button class="btn btn-primary" id="ex-go">다운로드</button></div>');
    $('[data-x="no"]', m).onclick = () => m.remove();
    $('#ex-fmt', m).onchange = () => {
      const f = $('#ex-fmt', m).value;
      $('#ex-audio-row', m).classList.toggle('hidden', f !== 'json');
      ['ex-sp', 'ex-time', 'ex-memo'].forEach(id => $('#' + id, m).parentElement.classList.toggle('hidden', !(f === 'txt' || f === 'doc')));
    };
    $('#ex-go', m).onclick = async () => {
      const f = $('#ex-fmt', m).value;
      const opts = { speaker: $('#ex-sp', m).checked, time: $('#ex-time', m).checked, memos: $('#ex-memo', m).checked };
      const name = VN.exporter.safeName(note.title);
      try {
        if (f === 'txt') VN.exporter.download(name + '.txt', VN.exporter.toTXT(note, opts));
        else if (f === 'doc') VN.exporter.download(name + '.doc', VN.exporter.toDOC(note, opts), 'application/msword;charset=utf-8');
        else if (f === 'srt') VN.exporter.download(name + '.srt', VN.exporter.toSRT(note));
        else if (f === 'vtt') VN.exporter.download(name + '.vtt', VN.exporter.toVTT(note), 'text/vtt;charset=utf-8');
        else if (f === 'json') VN.exporter.download(name + '.json', await VN.exporter.toJSON(note, $('#ex-audio', m).checked), 'application/json;charset=utf-8');
        else if (f === 'audio') {
          const ext = (note.audioBlob.type || '').includes('wav') ? 'wav' : (note.audioBlob.type || '').includes('mp4') ? 'm4a' : 'webm';
          VN.exporter.download(name + '.' + ext, note.audioBlob);
        }
        toast('다운로드를 시작했습니다.');
        m.remove();
      } catch (e) { toast('다운로드 실패: ' + (e.message || e)); }
    };
  }

  /* ══════════════ 녹음 화면 ══════════════ */

  function viewRecord() {
    const recSupported = VN.recorder.supported;
    const sttSupported = VN.stt.supported;
    let html = '<div class="view record-wrap">';
    if (!recSupported) {
      html += '<div class="banner">이 브라우저는 녹음(MediaRecorder)을 지원하지 않습니다. Chrome 또는 Edge를 사용해 주세요.</div>';
    }
    if (!sttSupported) {
      html += '<div class="banner">이 브라우저는 음성인식(SpeechRecognition)을 지원하지 않아 자막 없이 녹음만 진행됩니다. (Chrome/Edge 권장)</div>';
    }
    html += '<div id="rec-cal"></div>';
    html += '<div class="settings-row" style="justify-content:center"><label>인식 언어</label>' +
      '<select id="rec-lang">' +
      '<option value="ko-KR">한국어</option><option value="en-US">영어 (미국)</option>' +
      '<option value="ja-JP">일본어</option><option value="zh-CN">중국어 (간체)</option></select></div>' +
      '<div class="check-row" id="rec-wl-row" style="justify-content:center"><input type="checkbox" id="rec-wakelock"><label for="rec-wakelock" class="small">화면 켜짐 유지 (Wake Lock)</label></div>' +
      '<div class="record-timer" id="rec-timer">00:00</div>' +
      '<div class="record-state" id="rec-state">녹음 대기 중</div>' +
      '<canvas id="record-wave" width="640" height="90"></canvas>' +
      '<div class="record-controls" id="rec-controls">' +
      '<button class="btn btn-primary" id="rec-start"' + (recSupported ? '' : ' disabled') + '>● 녹음 시작</button>' +
      '</div>' +
      '<div class="speaker-tabs" id="rec-speakers"></div>' +
      '<div id="rec-warn"></div>' +
      '<div class="stt-live" id="stt-live"><span class="faint">녹음을 시작하면 실시간 자막이 여기에 표시됩니다.</span></div>' +
      '<div class="record-memo-row">' +
      '<button class="icon-btn" id="rec-bookmark" title="현재 시점 북마크" disabled>🔖</button>' +
      '<input type="text" id="rec-memo" placeholder="타임스탬프 메모 입력 후 Enter" disabled>' +
      '</div></div>';
    main().innerHTML = html;

    VN.db.getSetting('defaultLang', 'ko-KR').then(l => { $('#rec-lang') && ($('#rec-lang').value = l); });

    // Wake Lock 옵션 (미지원 브라우저는 숨김)
    if (!('wakeLock' in navigator)) {
      $('#rec-wl-row').classList.add('hidden');
    } else {
      VN.db.getSetting('wakeLock', false).then(v => { const c = $('#rec-wakelock'); if (c) c.checked = !!v; });
      $('#rec-wakelock').onchange = (e) => {
        VN.db.setSetting('wakeLock', e.target.checked);
        if (S.rec && S.rec.active) { if (e.target.checked) acquireWakeLock(); else releaseWakeLock(); }
      };
    }

    S.rec = {
      active: false, lang: 'ko-KR',
      segments: [], memos: [], bookmarks: [],
      speakers: [{ name: '참석자 1' }, { name: '참석자 2' }, { name: '참석자 3' }],
      curSpeaker: 0, timerId: null, sttWarned: false
    };

    const renderSpeakers = () => {
      const el = $('#rec-speakers');
      if (!el) return;
      el.innerHTML = S.rec.speakers.map((sp, i) =>
        '<button class="speaker-tab' + (i === S.rec.curSpeaker ? ' active' : '') + '" data-sp="' + i + '">' + U.esc(sp.name) + '</button>'
      ).join('') + (S.rec.speakers.length < 8 ? '<button class="speaker-tab" data-sp="add">＋</button>' : '');
      $$('.speaker-tab', el).forEach(b => b.onclick = () => {
        if (b.dataset.sp === 'add') {
          S.rec.speakers.push({ name: '참석자 ' + (S.rec.speakers.length + 1) });
          S.rec.curSpeaker = S.rec.speakers.length - 1;
        } else S.rec.curSpeaker = +b.dataset.sp;
        renderSpeakers();
      });
    };
    renderSpeakers();

    /* 캘린더 일정 → 제목·참석자 미리 채우기 */
    const applyEventToRec = (ev) => {
      if (!S.rec) return;
      S.rec.calendar = VN.gcal.toNoteCalendar(ev);
      S.rec.calTitle = VN.gcal.eventTitle(ev);
      const names = VN.gcal.attendeeNames(ev);
      if (names.length && !S.rec.active) {
        S.rec.speakers = names.map(n => ({ name: n }));
        S.rec.curSpeaker = 0;
        renderSpeakers();
      }
    };

    /* 현재시각 ±30분 일정 칩 — 로그인 안 됐거나 권한 없으면 조용히 숨김 */
    (async () => {
      let evs = [];
      try { evs = await VN.gcal.currentEvents(); } catch (e) { return; }
      const box = $('#rec-cal');
      if (!box || !evs.length || !S.rec) return;
      box.innerHTML = evs.map((ev, i) =>
        '<button class="btn btn-outline btn-block" data-ev="' + i + '" style="margin-bottom:6px;text-align:left">' +
        '📅 ' + U.esc(VN.gcal.eventTitle(ev)) + ' · 참석자 ' + VN.gcal.attendeeNames(ev).length + '명 — 이 일정으로 기록</button>'
      ).join('');
      $$('[data-ev]', box).forEach(b => b.onclick = () => {
        const ev = evs[+b.dataset.ev];
        applyEventToRec(ev);
        box.innerHTML = '<div class="banner info">📅 ' + U.esc(VN.gcal.eventTitle(ev)) + ' 일정으로 기록합니다.</div>';
      });
    })();

    const live = $('#stt-live');
    let interimEl = null;

    const appendFinal = (seg) => {
      S.rec.segments.push(seg);
      const div = document.createElement('div');
      div.className = 'segment';
      div.innerHTML = '<div class="seg-avatar" style="background:' + speakerColor(seg.speaker) + '">' +
        U.esc(S.rec.speakers[seg.speaker].name.slice(0, 2)) + '</div>' +
        '<div class="seg-body"><div class="seg-head"><span>' + U.esc(S.rec.speakers[seg.speaker].name) + '</span>' +
        '<span>' + U.fmtTime(seg.start) + '</span></div>' +
        '<div class="seg-text">' + U.esc(seg.text) + '</div></div>';
      if (interimEl) live.insertBefore(div, interimEl); else live.appendChild(div);
      live.scrollTop = live.scrollHeight;
    };
    const showInterim = (text) => {
      if (!interimEl) {
        interimEl = document.createElement('div');
        interimEl.className = 'interim';
        live.appendChild(interimEl);
      }
      interimEl.textContent = text || '';
      live.scrollTop = live.scrollHeight;
    };

    const startTimer = () => {
      // UI 갱신 전용 — 경과시간 데이터는 VN.recorder.currentTime()(Date.now 기반)이 진실.
      S.rec.timerId = setInterval(() => {
        const cur = U.fmtTime(VN.recorder.currentTime());
        const t = $('#rec-timer');
        if (t) t.textContent = cur;
        // 탭 숨김 중에도 1분 간격으로는 동작 → 제목으로 진행 상황 표시
        if (S.rec && S.rec.active) document.title = '● ' + cur + ' 녹음 중 — 보이스노트';
      }, 250);
    };

    const setControls = (mode) => {
      const c = $('#rec-controls');
      if (mode === 'recording') {
        c.innerHTML = '<button class="btn" id="rec-pause">⏸ 일시정지</button>' +
          '<button class="btn btn-primary" id="rec-stop">■ 중지·저장</button>' +
          '<button class="btn btn-ghost" id="rec-cancel">취소</button>';
        $('#rec-pause').onclick = () => {
          VN.recorder.pause();
          VN.stt.pause();
          $('#rec-state').innerHTML = '일시정지됨 <span class="faint">(일시정지 구간은 타임스탬프에서 제외)</span>';
          setControls('paused');
        };
      } else if (mode === 'paused') {
        c.innerHTML = '<button class="btn btn-primary" id="rec-resume">▶ 재개</button>' +
          '<button class="btn" id="rec-stop">■ 중지·저장</button>' +
          '<button class="btn btn-ghost" id="rec-cancel">취소</button>';
        $('#rec-resume').onclick = () => {
          VN.recorder.resume();
          if (VN.stt.supported) VN.stt.resume(S.rec.lang);
          $('#rec-state').innerHTML = '<span class="rec-dot"></span>녹음 중';
          setControls('recording');
        };
      }
      if ($('#rec-stop')) $('#rec-stop').onclick = () => finishRecording(false);
      if ($('#rec-cancel')) $('#rec-cancel').onclick = async () => {
        if (await confirmModal('녹음 취소', '지금까지 녹음한 내용이 모두 사라집니다.', '녹음 취소', true)) {
          VN.stt.stop();
          VN.recorder.cancel();
          clearInterval(S.rec.timerId);
          S.rec.active = false;
          releaseWakeLock();
          document.title = '보이스노트';
          go('#/list');
        }
      };
    };

    $('#rec-start').onclick = async () => {
      S.rec.lang = $('#rec-lang').value;
      VN.db.setSetting('defaultLang', S.rec.lang);
      try {
        await VN.recorder.start({
          canvas: $('#record-wave'),
          // 크래시 세이프: 5초마다 청크+메타 스냅샷을 IndexedDB recChunks에 flush
          persist: {
            getMeta: () => ({
              lang: S.rec.lang,
              speakers: S.rec.speakers,
              segments: S.rec.segments,
              memos: S.rec.memos,
              bookmarks: S.rec.bookmarks
            })
          }
        });
      } catch (e) {
        toast('녹음을 시작할 수 없습니다: ' + (e.message || e));
        return;
      }
      S.rec.active = true;
      S.rec.sttWarned = false;
      if ($('#rec-wakelock') && $('#rec-wakelock').checked) acquireWakeLock();
      live.innerHTML = '';
      interimEl = null;
      $('#rec-lang').disabled = true;
      $('#rec-bookmark').disabled = false;
      $('#rec-memo').disabled = false;
      $('#rec-state').innerHTML = '<span class="rec-dot"></span>녹음 중';
      setControls('recording');
      startTimer();
      if (VN.stt.supported) {
        VN.stt.start(S.rec.lang, {
          onInterim: showInterim,
          onFinal: (r) => appendFinal({
            id: U.uid(), speaker: S.rec.curSpeaker,
            start: r.start, end: r.end, text: r.text,
            bookmarked: false, highlighted: false
          }),
          onError: (msg) => toast(msg)
        });
      }
    };

    $('#rec-bookmark').onclick = () => {
      S.rec.bookmarks.push({ id: U.uid(), time: VN.recorder.currentTime() });
      toast('🔖 ' + U.fmtTime(VN.recorder.currentTime()) + ' 지점을 북마크했습니다.');
    };
    $('#rec-memo').onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const v = e.target.value.trim();
      if (!v) return;
      S.rec.memos.push({ id: U.uid(), time: VN.recorder.currentTime(), text: v, createdAt: Date.now() });
      e.target.value = '';
      toast('메모를 기록했습니다. (' + U.fmtTime(VN.recorder.currentTime()) + ')');
    };
  }

  /* 녹음 종료 → 노트 생성 (silent=true면 화면 전환 없이 저장만) */
  async function finishRecording(silent) {
    if (!S.rec || !S.rec.active) return;
    S.rec.active = false;
    VN.stt.stop();
    clearInterval(S.rec.timerId);
    releaseWakeLock();
    document.title = '보이스노트';
    let result;
    try {
      result = await VN.recorder.stop();
    } catch (e) {
      toast('녹음 저장 실패: ' + (e.message || e));
      return;
    }
    // 제목: 날짜 + 핵심 키워드
    const d = new Date();
    const dateStr = (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
    const text = S.rec.segments.map(s => s.text).join(' ');
    const kws = text ? VN.summarizer.keywords(text, 1) : [];
    // 캘린더 일정을 연결했으면 그 제목을 우선 사용
    const title = S.rec.calTitle || (dateStr + ' ' + (kws[0] || '녹음'));

    const note = VN.db.newNote({
      title,
      calendar: S.rec.calendar || null,
      language: S.rec.lang,
      duration: result.duration,
      audioBlob: result.blob,
      audioType: result.mimeType,
      sourceType: 'record',
      speakers: S.rec.speakers,
      segments: S.rec.segments,
      memos: S.rec.memos,
      bookmarks: S.rec.bookmarks,
      waveform: result.waveform
    });
    await VN.db.saveNote(note);
    // 노트가 안전하게 저장됐으니 크래시 세이프 청크 정리
    try { await VN.db.clear('recChunks'); } catch (e) { /* ignore */ }
    S.rec = null;
    // Drive 자동 저장 (주제 생성 → 파일명·노트 제목 확정 → 활성 경로 전부 저장)
    await driveAutoSaveAfter(note);
    if (!silent) {
      toast('노트가 생성되었습니다.');
      go('#/note/' + note.id);
    }
  }

  /* ══════════════ 파일 불러오기 ══════════════ */

  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|webm|ogg)$/i;

  function fileTag(name) {
    if (/통화|call|phone|전화/i.test(name)) return '통화';
    if (/회의|meeting|mtg|미팅|conference/i.test(name)) return '회의';
    return '기타';
  }

  async function analyzeAudio(blob) {
    // 길이·파형 추출 (decodeAudioData 실패 시 파형 생략)
    try {
      const buf = await blob.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData(buf);
      const ch = audioBuf.getChannelData(0);
      const buckets = 240;
      const per = Math.floor(ch.length / buckets) || 1;
      const wf = [];
      for (let i = 0; i < buckets; i++) {
        let max = 0;
        for (let j = i * per; j < (i + 1) * per && j < ch.length; j += 32) {
          const v = Math.abs(ch[j]);
          if (v > max) max = v;
        }
        wf.push(max);
      }
      try { ctx.close(); } catch (e) { /* ignore */ }
      return { duration: audioBuf.duration, waveform: wf };
    } catch (e) {
      return { duration: 0, waveform: null };
    }
  }

  async function importFiles(files) {
    const audioFiles = [...files].filter(f => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/'));
    if (!audioFiles.length) { toast('지원하는 오디오 파일이 아닙니다. (mp3/m4a/aac/wav/webm/ogg)'); return; }
    let lastNote = null;
    for (const f of audioFiles) {
      toast('"' + f.name + '" 분석 중…');
      const info = await analyzeAudio(f);
      const note = VN.db.newNote({
        title: f.name.replace(/\.[^.]+$/, ''),
        duration: info.duration,
        audioBlob: f,
        audioType: f.type || '',
        sourceType: 'upload',
        tags: [fileTag(f.name)],
        waveform: info.waveform,
        language: await VN.db.getSetting('defaultLang', 'ko-KR')
      });
      await VN.db.saveNote(note);
      lastNote = note;
    }
    await refresh();
    renderSidebar(location.hash);
    if (audioFiles.length === 1 && lastNote) {
      transcribeChoiceModal(lastNote);
    } else {
      toast(audioFiles.length + '개 파일을 불러왔습니다.');
      route();
    }
  }

  /* ── 전사 방식 선택지 (업로드 직후 / 재변환 공통) ── */

  const PROVIDER_LABEL = { deepgram: 'Deepgram', assemblyai: 'AssemblyAI' };

  async function diarizeReady(provider) {
    try { return !!(VN.diarize && await VN.diarize.isConfigured(provider)); }
    catch (e) { return false; }
  }

  /* 사용 가능 여부를 미리 조회해 비활성 처리까지 마친 옵션 버튼 HTML */
  async function transcribeOptionsHtml() {
    const [gem, dg, aai] = await Promise.all([
      VN.db.getSetting('geminiApiKey', ''),
      diarizeReady('deepgram'),
      diarizeReady('assemblyai')
    ]);
    const hint = '<div class="muted small" style="margin:-4px 0 8px">설정에서 키 입력이 필요합니다.</div>';
    return {
      gem: !!gem, dg, aai,
      html:
        '<button class="btn btn-primary btn-block" data-tc="gemini" style="margin-bottom:8px"' + (gem ? '' : ' disabled') + '>✨ Gemini AI 변환 (화자 추정)</button>' +
        (gem ? '' : '<div class="muted small" style="margin:-4px 0 8px">Gemini API 키가 없습니다. 설정 → 고급 모드에서 키를 저장하세요.</div>') +
        '<button class="btn btn-block" data-tc="deepgram" style="margin-bottom:8px"' + (dg ? '' : ' disabled') + '>🎙 Deepgram (자동 화자분리)</button>' +
        (dg ? '' : hint) +
        '<button class="btn btn-block" data-tc="assemblyai" style="margin-bottom:8px"' + (aai ? '' : ' disabled') + '>🎙 AssemblyAI (자동 화자분리)</button>' +
        (aai ? '' : hint) +
        '<button class="btn btn-block" data-tc="whisper" style="margin-bottom:8px">🤖 Whisper AI 변환 (인터넷 필요)</button>' +
        '<button class="btn btn-block" data-tc="manual" style="margin-bottom:8px">✍️ 수동 전사 (구간을 추가하며 직접 입력)</button>'
    };
  }

  async function transcribeChoiceModal(note) {
    const opt = await transcribeOptionsHtml();
    const m = modal('<h2>텍스트 변환</h2><div class="modal-body">' +
      '<p class="muted" style="margin-bottom:10px">"' + U.esc(note.title) + '" 노트를 만들었습니다. 어떻게 텍스트로 변환할까요?</p>' +
      opt.html +
      '<button class="btn btn-ghost btn-block" data-tc="later">나중에 하기</button></div>');
    $$('[data-tc]', m).forEach(b => b.onclick = async () => {
      const kind = b.dataset.tc;
      if (kind === 'gemini') { m.remove(); geminiTranscribeModal(note); return; }
      if (kind === 'whisper') { m.remove(); whisperModal(note); return; }
      if (kind === 'later') { m.remove(); go('#/note/' + note.id); return; }
      if (kind === 'manual') {
        m.remove(); go('#/note/' + note.id);
        toast('음성 기록 탭의 "구간 추가"로 전사를 입력하세요.');
        return;
      }
      // deepgram | assemblyai — 새 노트라 대체 확인은 생략
      m.remove();
      const ok = await diarizeTranscribe(note, kind, { confirm: false });
      if (ok) await driveAutoSaveAfter(note);
      go('#/note/' + note.id);
    });
  }

  /* 노트 상세 🎤: 재변환 방식 선택 */
  async function retranscribeModal(note) {
    if (!(note.audioBlob instanceof Blob)) { toast('오디오가 없는 노트입니다.'); return; }
    const opt = await transcribeOptionsHtml();
    const m = modal('<h2>오디오 전체 재변환</h2><div class="modal-body">' +
      '<p class="muted small" style="margin-bottom:10px">오디오 전체를 다시 전사합니다. 기존 세그먼트 ' +
      (note.segments || []).length + '개와 참석자 이름이 대체됩니다.</p>' + opt.html +
      '</div><div class="modal-actions"><button class="btn" data-tc="cancel">취소</button></div>');
    $$('[data-tc]', m).forEach(b => b.onclick = async () => {
      const kind = b.dataset.tc;
      m.remove();
      if (kind === 'cancel') return;
      if (kind === 'gemini') { geminiRetranscribe(note); return; }
      if (kind === 'whisper') { whisperModal(note); return; }
      if (kind === 'manual') { toast('음성 기록 탭의 "구간 추가"로 직접 입력하세요.'); return; }
      const ok = await diarizeTranscribe(note, kind, { confirm: true });
      if (ok) viewNote(note.id);
    });
  }

  /* 화자 인덱스(0..N) → 참석자1..N 매핑 후 세그먼트 교체 — 순수 함수 */
  function applyDiarizeSegments(note, result) {
    const segs = (result && Array.isArray(result.segments)) ? result.segments : [];
    let maxSp = 0;
    for (const s of segs) maxSp = Math.max(maxSp, Math.max(0, s.speaker | 0));
    const speakers = [];
    for (let i = 0; i <= maxSp; i++) speakers.push({ name: '참석자 ' + (i + 1) });
    note.speakers = speakers;
    note.segments = segs.map(s => {
      const start = Number(s.start) || 0;
      const end = Number(s.end);
      return {
        id: U.uid(),
        speaker: Math.max(0, s.speaker | 0),
        start,
        end: (isFinite(end) && end > start) ? end : start + 3,
        text: String(s.text || ''),
        bookmarked: false, highlighted: false
      };
    });
  }

  /* VN.diarize 호출 + 진행률 표시. 성공하면 true */
  async function diarizeTranscribe(note, provider, opts) {
    opts = opts || {};
    const label = PROVIDER_LABEL[provider] || provider;
    if (!(note.audioBlob instanceof Blob)) { toast('오디오가 없는 노트입니다.'); return false; }
    if (!(await diarizeReady(provider))) {
      toast(label + ' 키가 없습니다. 설정에서 키를 입력하세요.');
      return false;
    }
    if (opts.confirm) {
      const ok = await confirmModal('자동 화자분리 재변환 (' + label + ')',
        '오디오 전체를 다시 전사하고 화자를 자동으로 나눕니다.<br>기존 세그먼트 ' +
        (note.segments || []).length + '개와 참석자 이름이 <b>대체</b>됩니다.', '재변환', true);
      if (!ok) return false;
    }
    const m = modal('<h2>' + U.esc(label) + ' 변환</h2><div class="modal-body">' +
      '<div id="dz-status" class="muted small">변환 중…</div>' +
      '<div class="progress-outer"><div class="progress-inner" id="dz-prog"></div></div></div>');
    try {
      const r = await VN.diarize.transcribe(note.audioBlob, {
        provider,
        language: note.language,
        onProgress: (a, b) => {
          // VN.diarize는 0~1 비율로 알린다. 0~100 형태도 함께 허용.
          let val = 0, msg = '';
          if (typeof a === 'number') { val = a; msg = b || ''; }
          else if (a && typeof a === 'object') { val = Number(a.pct || a.percent || a.progress || 0); msg = a.message || a.msg || ''; }
          if (!isFinite(val) || val < 0) val = 0;
          const pct = val <= 1 ? val * 100 : val;
          const p = $('#dz-prog', m), st = $('#dz-status', m);
          if (p) p.style.width = Math.min(100, pct) + '%';
          if (st && msg) st.textContent = msg;
        }
      });
      applyDiarizeSegments(note, r);
      await saveNote(note);
      m.remove();
      const cnt = (r && Array.isArray(r.segments)) ? r.segments.length : 0;
      toast(cnt + '개 구간 · 화자 ' + (note.speakers || []).length + '명으로 변환했습니다.');
      return true;
    } catch (e) {
      m.remove();
      toast(label + ' 변환 실패: ' + ((e && e.message) || e));
      return false;
    }
  }

  function whisperModal(note) {
    const m = modal('<h2>Whisper AI 변환</h2><div class="modal-body">' +
      '<p class="muted small" style="margin-bottom:10px">브라우저에서 Whisper 모델을 내려받아 기기 내에서 변환합니다. 최초 1회 모델 다운로드(수십 MB)가 필요하며 시간이 걸릴 수 있습니다.</p>' +
      '<div class="form-row"><label>모델</label><select id="wh-model">' +
      '<option value="tiny">tiny (빠름, 정확도 낮음)</option>' +
      '<option value="base">base (느림, 정확도 높음)</option></select></div>' +
      '<div class="form-row"><label>언어</label><select id="wh-lang">' +
      '<option value="ko-KR">한국어</option><option value="en-US">영어</option>' +
      '<option value="ja-JP">일본어</option><option value="zh-CN">중국어</option></select></div>' +
      '<div id="wh-status" class="muted small"></div>' +
      '<div class="progress-outer"><div class="progress-inner" id="wh-prog"></div></div>' +
      '</div><div class="modal-actions"><button class="btn" data-x="no">닫기</button>' +
      '<button class="btn btn-primary" id="wh-go">변환 시작</button></div>');
    $('#wh-lang', m).value = note.language || 'ko-KR';
    $('[data-x="no"]', m).onclick = () => { m.remove(); go('#/note/' + note.id); };
    $('#wh-go', m).onclick = async () => {
      const btn = $('#wh-go', m);
      btn.disabled = true;
      try {
        const segs = await VN.whisper.transcribe(note.audioBlob, {
          model: $('#wh-model', m).value,
          language: $('#wh-lang', m).value,
          onProgress: (pct, msg) => {
            const p = $('#wh-prog', m), st = $('#wh-status', m);
            if (p) p.style.width = pct + '%';
            if (st) st.textContent = msg || '';
          }
        });
        note.segments = segs.map(s => ({
          id: U.uid(), speaker: 0, start: s.start, end: s.end, text: s.text,
          bookmarked: false, highlighted: false
        }));
        note.language = $('#wh-lang', m).value;
        await saveNote(note);
        toast(segs.length + '개 구간을 변환했습니다.');
        m.remove();
        await driveAutoSaveAfter(note);
        go('#/note/' + note.id);
      } catch (e) {
        const st = $('#wh-status', m);
        if (st) st.innerHTML = '<span style="color:var(--danger)">' + U.esc(e.message || String(e)) + '</span>';
        btn.disabled = false;
      }
    };
  }

  /* ══════════════ Gemini 오디오 전사 ══════════════ */

  /* Gemini 전사 결과 → 노트 세그먼트·참석자 적용 (기존 세그먼트 대체) */
  function applyGeminiSegments(note, items) {
    const labels = [];
    for (const it of items) if (!labels.includes(it.speakerLabel)) labels.push(it.speakerLabel);
    if (!labels.length) labels.push('참석자 1');
    note.speakers = labels.map(l => ({ name: l }));
    note.segments = items.map((it, i) => ({
      id: U.uid(),
      speaker: Math.max(0, labels.indexOf(it.speakerLabel)),
      start: it.start,
      end: items[i + 1] ? Math.max(it.start, items[i + 1].start) : it.start + 3,
      text: it.text,
      bookmarked: false, highlighted: false
    }));
  }

  /* 업로드 변환 모달의 Gemini 경로 */
  function geminiTranscribeModal(note) {
    const m = modal('<h2>Gemini AI 변환</h2><div class="modal-body">' +
      '<p class="muted small" style="margin-bottom:10px">오디오 전체를 Gemini 2.5 Flash에 보내 화자 추정과 함께 전사합니다. (오디오 18MB 이하, 인터넷 필요)</p>' +
      '<div id="gm-status" class="muted small">준비됨</div>' +
      '</div><div class="modal-actions"><button class="btn" data-x="no">닫기</button>' +
      '<button class="btn btn-primary" id="gm-go">변환 시작</button></div>');
    $('[data-x="no"]', m).onclick = () => { m.remove(); go('#/note/' + note.id); };
    $('#gm-go', m).onclick = async () => {
      const btn = $('#gm-go', m);
      btn.disabled = true;
      $('#gm-status', m).textContent = '변환 중… (오디오 길이에 따라 수십 초 걸릴 수 있습니다)';
      try {
        const items = await VN.summarizer.transcribeAudioGemini(note.audioBlob, { language: note.language });
        applyGeminiSegments(note, items);
        await saveNote(note);
        toast(items.length + '개 발화를 변환했습니다.');
        m.remove();
        await driveAutoSaveAfter(note);
        go('#/note/' + note.id);
      } catch (e) {
        const st = $('#gm-status', m);
        if (st) st.innerHTML = '<span style="color:var(--danger)">' + U.esc(e.message || String(e)) + '</span>';
        btn.disabled = false;
      }
    };
  }

  /* 노트 상세: 오디오 전체 재변환 (기존 세그먼트 대체 전 확인) */
  async function geminiRetranscribe(note) {
    const key = await VN.db.getSetting('geminiApiKey', '');
    if (!key) { toast('Gemini API 키가 없습니다. 설정 → 고급 모드에서 저장하세요.'); return; }
    if (!(note.audioBlob instanceof Blob)) { toast('오디오가 없는 노트입니다.'); return; }
    const n = (note.segments || []).length;
    const ok = await confirmModal('오디오 전체 재변환 (Gemini)',
      '오디오 전체를 Gemini로 다시 전사합니다.<br>기존 세그먼트 ' + n + '개와 참석자 이름이 <b>대체</b>됩니다.', '재변환', true);
    if (!ok) return;
    toast('Gemini 재변환 중… (수십 초 걸릴 수 있습니다)');
    try {
      const items = await VN.summarizer.transcribeAudioGemini(note.audioBlob, { language: note.language });
      applyGeminiSegments(note, items);
      await saveNote(note);
      toast(items.length + '개 발화로 재변환했습니다.');
      viewNote(note.id);
    } catch (e) { toast('재변환 실패: ' + (e.message || e)); }
  }

  /* ══════════════ 캘린더 일정 연결 ══════════════ */

  async function calendarLinkModal(note) {
    let evs = [];
    try { evs = await VN.gcal.nearbyEvents(); } catch (e) { evs = []; }
    if (!evs.length) { toast('최근 7일 ~ 앞으로 7일 사이에 일정이 없습니다.'); return; }
    const rows = evs.map((ev, i) =>
      '<label class="check-row" style="align-items:flex-start;gap:8px">' +
      '<input type="radio" name="cal-ev" value="' + i + '"' + (i === 0 ? ' checked' : '') + '>' +
      '<span class="small"><b>' + U.esc(VN.gcal.eventTitle(ev)) + '</b><br>' +
      '<span class="muted">' + U.fmtDate(VN.gcal.eventStartMs(ev)) +
      ' · 참석자 ' + VN.gcal.attendeeNames(ev).length + '명</span></span></label>'
    ).join('');
    const m = modal('<h2>📅 일정 연결</h2><div class="modal-body">' +
      '<div style="max-height:280px;overflow:auto;margin-bottom:10px">' + rows + '</div>' +
      '<div class="check-row"><input type="checkbox" id="cal-t" checked><label for="cal-t" class="small">노트 제목을 일정 제목으로 변경</label></div>' +
      '<div class="check-row"><input type="checkbox" id="cal-a" checked><label for="cal-a" class="small">참석자 이름 적용</label></div>' +
      '</div><div class="modal-actions"><button class="btn" data-x="no">취소</button>' +
      '<button class="btn btn-primary" data-x="ok">연결</button></div>');
    $('[data-x="no"]', m).onclick = () => m.remove();
    $('[data-x="ok"]', m).onclick = async () => {
      const sel = $('input[name="cal-ev"]:checked', m);
      if (!sel) { m.remove(); return; }
      const ev = evs[+sel.value];
      note.calendar = VN.gcal.toNoteCalendar(ev);
      if ($('#cal-t', m).checked) note.title = VN.gcal.eventTitle(ev);
      if ($('#cal-a', m).checked) {
        const names = VN.gcal.attendeeNames(ev);
        const sp = (note.speakers || []).slice();
        names.forEach((n, i) => { sp[i] = Object.assign({}, sp[i] || {}, { name: n }); });
        if (sp.length) note.speakers = sp;
      }
      await saveNote(note);
      m.remove();
      toast('일정을 연결했습니다.');
      viewNote(note.id);
    };
  }

  /* ── 노트 생성·변환 직후 Drive 자동 저장 ── */
  async function driveAutoSaveAfter(note) {
    try {
      const r = await VN.drive.autoSave(note);
      if (r && r.saved) toast('Drive 저장 완료: ' + (r.filename || ''));
      else if (r && !r.skipped && r.message) toast(r.message);
      return r;
    } catch (e) { toast('Drive 자동 저장 실패: ' + (e.message || e)); }
  }

  /* ══════════════ 휴지통 ══════════════ */

  async function viewTrash() {
    const items = await VN.db.getTrash();
    let html = '<div class="view"><div class="view-header"><h1>휴지통</h1><div class="spacer"></div>' +
      (items.length ? '<button class="btn btn-danger btn-sm" id="btn-trash-empty">비우기</button>' : '') + '</div>' +
      '<p class="muted small" style="margin-bottom:14px">삭제된 노트는 30일간 보관 후 자동으로 영구 삭제됩니다.</p>' +
      '<div id="trash-list"></div></div>';
    main().innerHTML = html;
    const list = $('#trash-list');
    if (!items.length) {
      list.innerHTML = '<div class="empty-state"><div class="big">🗑️</div>휴지통이 비어 있습니다.</div>';
      return;
    }
    list.innerHTML = items.map(n => {
      const daysLeft = Math.max(0, Math.ceil((VN.db.TRASH_KEEP_MS - (Date.now() - n.deletedAt)) / 86400000));
      return '<div class="trash-item"><div><div class="t-title">' + U.esc(n.title) + '</div>' +
        '<div class="t-meta">삭제: ' + U.fmtDate(n.deletedAt) + ' · ' + daysLeft + '일 후 영구 삭제</div></div>' +
        '<div class="t-actions"><button class="btn btn-sm" data-restore="' + n.id + '">복원</button>' +
        '<button class="btn btn-sm btn-danger" data-purge="' + n.id + '">영구 삭제</button></div></div>';
    }).join('');
    $$('[data-restore]', list).forEach(b => b.onclick = async () => {
      await VN.db.restoreNote(b.dataset.restore);
      toast('복원했습니다.');
      route();
    });
    $$('[data-purge]', list).forEach(b => b.onclick = async () => {
      if (await confirmModal('영구 삭제', '이 노트를 영구 삭제합니다. 되돌릴 수 없습니다.', '영구 삭제', true)) {
        await VN.db.purgeNote(b.dataset.purge);
        route();
      }
    });
    if ($('#btn-trash-empty')) $('#btn-trash-empty').onclick = async () => {
      if (await confirmModal('휴지통 비우기', '휴지통의 모든 노트를 영구 삭제합니다. 되돌릴 수 없습니다.', '모두 삭제', true)) {
        await VN.db.emptyTrash();
        route();
      }
    };
  }

  /* ══════════════ 설정 ══════════════ */

  async function viewSettings() {
    const [lang, theme, apiKey, driveAuto, driveFormat, driveAudio, hookUrl, hookToken, driveLast, folderStatus,
      clientId, gStatus, apiStatus, driveTarget, dgKey, aaiKey] = await Promise.all([
      VN.db.getSetting('defaultLang', 'ko-KR'),
      VN.db.getSetting('theme', 'system'),
      VN.db.getSetting('geminiApiKey', ''),
      VN.db.getSetting('driveAutoSave', true),
      VN.db.getSetting('driveFormat', 'doc'),
      VN.db.getSetting('driveAudio', false),
      VN.db.getSetting('appsScriptUrl', ''),
      VN.db.getSetting('appsScriptToken', ''),
      VN.drive.getLastResult(),
      VN.drive.getFolderStatus(),
      VN.gauth.getClientId(),
      VN.gauth.status(),
      VN.drive.getApiStatus(),
      VN.drive.getTarget(),
      VN.db.getSetting('deepgramApiKey', ''),
      VN.db.getSetting('assemblyaiApiKey', '')
    ]);
    // 사용 통계
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthNotes = S.notes.filter(n => n.createdAt >= monthStart);
    const monthSec = monthNotes.reduce((a, n) => a + (n.duration || 0), 0);
    const totalSec = S.notes.reduce((a, n) => a + (n.duration || 0), 0);

    let html = '<div class="view"><div class="view-header"><h1>설정</h1></div>';

    html += '<div class="settings-group"><h2>이번 달 사용량 <span class="faint small">(제한 없음)</span></h2>' +
      '<div class="stat-cards">' +
      '<div class="stat-card"><div class="val">' + U.fmtTime(monthSec) + '</div><div class="lbl">이번 달 녹음 시간</div></div>' +
      '<div class="stat-card"><div class="val">' + U.fmtTime(totalSec) + '</div><div class="lbl">누적 녹음 시간</div></div>' +
      '<div class="stat-card"><div class="val">' + S.notes.length + '</div><div class="lbl">전체 노트 수</div></div>' +
      '</div><div class="muted small" style="margin-top:8px" id="st-storage"></div></div>';

    html += '<div class="settings-group"><h2>일반</h2>' +
      '<div class="settings-row"><label>기본 인식 언어</label><select id="st-lang">' +
      '<option value="ko-KR">한국어</option><option value="en-US">영어 (미국)</option>' +
      '<option value="ja-JP">일본어</option><option value="zh-CN">중국어 (간체)</option></select></div>' +
      '<div class="settings-row"><label>테마</label><select id="st-theme">' +
      '<option value="system">시스템 설정 따름</option><option value="light">라이트</option><option value="dark">다크</option></select></div></div>';

    html += '<div class="settings-group"><h2>고급 모드(Gemini 2.5 Flash)</h2>' +
      '<p class="muted small" style="margin-bottom:8px">API 키를 입력하면 요약·주제·할 일·키워드를 Gemini가 생성합니다. Google AI Studio(aistudio.google.com/apikey)에서 무료 발급, 브라우저에만 저장됨. 실패 시 기본 모드로 자동 폴백합니다.</p>' +
      '<div class="settings-row"><label>Gemini API 키</label>' +
      '<input type="password" id="st-apikey" style="flex:1;min-width:160px" placeholder="' + (apiKey ? '저장됨 (••••' + apiKey.slice(-4) + ')' : 'AIza…') + '">' +
      '<button class="btn btn-sm btn-primary" id="st-apikey-save">저장</button>' +
      (apiKey ? '<button class="btn btn-sm" id="st-apikey-del">삭제</button>' : '') + '</div></div>';

    /* ── 자동 화자분리 API 키 ── */
    const keyRow = (id, label, val, ph) =>
      '<div class="settings-row"><label>' + label + '</label>' +
      '<input type="password" id="' + id + '" style="flex:1;min-width:160px" placeholder="' +
      (val ? '저장됨 (••••' + U.esc(val.slice(-4)) + ')' : ph) + '">' +
      '<button class="btn btn-sm btn-primary" data-keysave="' + id + '">저장</button>' +
      (val ? '<button class="btn btn-sm" data-keydel="' + id + '">삭제</button>' : '') + '</div>';

    html += '<div class="settings-group"><h2>자동 화자분리 (Deepgram / AssemblyAI)</h2>' +
      '<p class="muted small" style="margin-bottom:8px">키를 저장하면 업로드 변환·오디오 전체 재변환에서 화자를 자동으로 나눠 전사할 수 있습니다. 키는 이 브라우저(IndexedDB)에만 저장됩니다.</p>' +
      keyRow('st-dg-key', 'Deepgram API 키', dgKey, '키 입력') +
      keyRow('st-aai-key', 'AssemblyAI API 키', aaiKey, '키 입력') + '</div>';

    /* ── Google 계정 (OAuth) ── */
    html += '<div class="settings-group"><h2>Google 계정 (Drive API · Calendar)</h2>' +
      '<p class="muted small" style="margin-bottom:8px">로그인하면 Android에서도 별도 설정 없이 회의록이 Drive에 업로드되고, 캘린더 일정으로 회의 제목·참석자를 자동으로 채웁니다. 클라이언트 ID 발급 방법은 README의 "Google Cloud 콘솔 설정"을 참고하세요.</p>' +
      '<div class="settings-row"><label>클라이언트 ID</label>' +
      '<input type="text" id="ga-clientid" style="flex:1;min-width:200px" value="' + U.esc(clientId) + '" placeholder="…apps.googleusercontent.com">' +
      '<button class="btn btn-sm btn-primary" id="ga-clientid-save">저장</button></div>' +
      '<div class="settings-row"><label>상태</label>' +
      (!gStatus.configured
        ? '<span class="muted small">클라이언트 ID를 먼저 저장하세요.</span>'
        : (gStatus.signedIn
          ? '<span class="small">✅ 로그인됨' + (gStatus.email ? ' — ' + U.esc(gStatus.email) : '') + '</span>'
          : (gStatus.hasToken
            ? '<span class="small" style="color:var(--danger)">토큰이 만료되었습니다 — 다시 로그인해 주세요.</span>'
            : '<span class="muted small">로그인 안 됨</span>'))) +
      '<button class="btn btn-sm btn-primary" id="ga-signin"' + (gStatus.configured ? '' : ' disabled') + '>' +
      (gStatus.signedIn ? '다시 로그인' : 'Google 로그인') + '</button>' +
      (gStatus.hasToken ? '<button class="btn btn-sm" id="ga-signout">로그아웃</button>' : '') + '</div>' +
      '<div class="settings-row"><label>Drive 폴더</label>' +
      (apiStatus.folderName
        ? '<span class="small">📁 ' + U.esc(apiStatus.folderName) + '</span>'
        : '<span class="muted small">아직 확인 안 됨 (저장 시 "' + U.esc(VN.drive.FOLDER_NAME) + '" 폴더를 찾거나 만듭니다)</span>') +
      '<button class="btn btn-sm" id="ga-refolder"' + (gStatus.configured ? '' : ' disabled') + '>폴더 다시 찾기</button></div></div>';

    /* ── Google Drive 자동 저장 ── */
    const APPS_SCRIPT_CODE =
      "const SECRET = 'CHANGE_ME'; // 원하는 문자열로 변경\n" +
      "function doPost(e) {\n" +
      "  const d = JSON.parse(e.postData.contents);\n" +
      "  if (d.token !== SECRET) return out_({ok:false, error:'bad token'});\n" +
      "  const folder = folder_('회의록');\n" +
      "  const blob = Utilities.newBlob(Utilities.base64Decode(d.dataBase64), d.mimeType || 'application/octet-stream', d.filename);\n" +
      "  const f = folder.createFile(blob);\n" +
      "  return out_({ok:true, id:f.getId(), url:f.getUrl()});\n" +
      "}\n" +
      "function folder_(name){ const it = DriveApp.getFoldersByName(name); return it.hasNext() ? it.next() : DriveApp.createFolder(name); }\n" +
      "function out_(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }";

    html += '<div class="settings-group"><h2>Google Drive 자동 저장</h2>' +
      '<p class="muted small" style="margin-bottom:8px">녹음 종료·업로드 변환 직후 회의록을 자동 저장합니다. 파일명은 <b>날짜_시각_대화주제</b>(연결된 캘린더 일정 제목 우선, 없으면 Gemini 주제·키워드)로 만들어집니다. 아래에서 고른 <b>한 경로</b>에만 저장됩니다.</p>' +
      '<div class="settings-row"><label>자동 저장</label><input type="checkbox" id="dr-auto"' + (driveAuto ? ' checked' : '') + '></div>' +
      '<div class="settings-row" style="align-items:flex-start"><label>저장 경로</label>' +
      '<div style="display:flex;flex-direction:column;gap:6px">' +
      [['folder', 'PC 폴더 (Google Drive for Desktop)'],
       ['api', 'Drive API (권장 · PC/Android 공용)'],
       ['webhook', 'Apps Script 웹훅'],
       ['none', '사용 안 함']].map(o =>
        '<label class="small" style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="radio" name="dr-target" value="' + o[0] + '"' + (driveTarget === o[0] ? ' checked' : '') + '>' +
        o[1] + '</label>').join('') +
      '</div></div>' +
      '<div class="settings-row"><label>파일 형식</label><select id="dr-fmt">' +
      '<option value="doc"' + (driveFormat === 'doc' ? ' selected' : '') + '>DOC (Word 호환)</option>' +
      '<option value="txt"' + (driveFormat === 'txt' ? ' selected' : '') + '>TXT (텍스트)</option></select>' +
      '<span class="check-row" style="margin:0"><input type="checkbox" id="dr-audio"' + (driveAudio ? ' checked' : '') + '><label for="dr-audio" class="small">오디오(webm)도 함께 저장</label></span></div>';
    if (folderStatus.supported) {
      html += '<div class="settings-row"><label>PC 저장 폴더</label>' +
        (folderStatus.name
          ? '<span class="small">📁 ' + U.esc(folderStatus.name) + (folderStatus.permission === 'granted' ? '' : ' <span style="color:var(--danger)">(재승인 필요)</span>') + '</span>'
          : '<span class="muted small">선택 안 됨 — 예: G:\\내 드라이브\\회의록</span>') +
        '<button class="btn btn-sm" id="dr-pick">PC 저장 폴더 선택</button>' +
        (folderStatus.name && folderStatus.permission !== 'granted' ? '<button class="btn btn-sm btn-primary" id="dr-perm">재승인</button>' : '') +
        (folderStatus.name ? '<button class="btn btn-sm" id="dr-unpick">해제</button>' : '') +
        '</div>';
    } else {
      html += '<p class="muted small">이 브라우저는 PC 폴더 저장(File System Access API)을 지원하지 않습니다. Android에서는 아래 Apps Script 웹훅을 사용하세요.</p>';
    }
    html += '<div class="settings-row"><label>Apps Script URL</label><input type="text" id="dr-url" style="flex:1;min-width:160px" value="' + U.esc(hookUrl) + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
      '<div class="settings-row"><label>비밀 토큰</label><input type="password" id="dr-token" style="flex:1;min-width:120px" value="' + U.esc(hookToken) + '" placeholder="Apps Script의 SECRET 값">' +
      '<button class="btn btn-sm btn-primary" id="dr-hook-save">저장</button></div>' +
      '<div class="muted small" id="dr-last" style="margin-top:4px">' +
      (driveLast ? '마지막 저장: ' + U.fmtDate(driveLast.time) + ' — ' + (driveLast.ok ? '✅ ' : '⚠️ ') + U.esc(driveLast.message || '') : '아직 저장 이력이 없습니다.') + '</div>' +
      '<details style="margin-top:10px"><summary style="cursor:pointer;font-weight:600">Apps Script 웹훅 설정 방법 (Android·클라우드 직접 업로드)</summary>' +
      '<div class="muted small" style="line-height:1.8;margin-top:6px">' +
      '1. <b>script.google.com</b> → 새 프로젝트 → 아래 코드 붙여넣기 (SECRET을 원하는 문자열로 변경)<br>' +
      '2. 배포 → <b>새 배포</b> → 유형: <b>웹 앱</b> → 실행: <b>나</b> → 액세스: <b>링크가 있는 모든 사용자</b> → 배포<br>' +
      '3. 웹 앱 <b>URL 복사</b> → 위 "Apps Script URL"에 붙여넣고, SECRET 값을 "비밀 토큰"에 입력 후 저장<br>' +
      '· 회의록은 내 Drive의 <b>회의록</b> 폴더에 저장됩니다. 전송 실패 시 재시도 큐에 보관했다가 앱 시작 시 다시 보냅니다. 18MB 초과 페이로드는 건너뜁니다.</div>' +
      '<pre style="overflow:auto;background:var(--bg-hover);padding:10px;border-radius:8px;font-size:11px;line-height:1.5;margin-top:8px">' + U.esc(APPS_SCRIPT_CODE) + '</pre>' +
      '</details></div>';

    html += '<div class="settings-group"><h2>데이터 관리</h2>' +
      '<div class="settings-row"><label>전체 백업</label>' +
      '<span class="check-row" style="margin:0"><input type="checkbox" id="st-bk-audio" checked><label for="st-bk-audio" class="small">오디오 포함(base64)</label></span>' +
      '<button class="btn btn-sm" id="st-backup">백업 파일 다운로드</button></div>' +
      '<div class="settings-row"><label>복원 (가져오기)</label><button class="btn btn-sm" id="st-restore">백업 파일 선택</button></div>' +
      '<div class="settings-row"><label>전체 삭제</label><button class="btn btn-sm btn-danger" id="st-wipe">모든 데이터 삭제</button></div>' +
      '<p class="muted small">클라우드 동기화 대신 백업 파일로 다른 기기에 옮길 수 있습니다.</p></div>';

    html += '<div class="settings-group"><h2>데모</h2>' +
      '<div class="settings-row"><label>데모 노트</label><button class="btn btn-sm btn-primary" id="st-demo">데모 노트 생성</button></div>' +
      '<p class="muted small">회의 시나리오(화자 3인·메모·북마크·하이라이트·합성 오디오)가 담긴 예시 노트를 만듭니다.</p></div>';

    html += '<div class="settings-group"><h2>도움말</h2><div class="muted small" style="line-height:1.8">' +
      '· 마이크 녹음과 실시간 음성인식은 Chrome/Edge + localhost(또는 HTTPS)에서만 동작합니다.<br>' +
      '· 실시간 음성인식(SpeechRecognition)은 브라우저가 제공하는 온라인 서비스라 인터넷 연결이 필요합니다.<br>' +
      '· Firefox는 음성인식을 지원하지 않아 녹음만 가능합니다. 이후 Whisper AI 변환을 사용하세요.<br>' +
      '· 모든 데이터는 이 브라우저(IndexedDB)에만 저장됩니다. 브라우저 데이터 삭제 시 함께 삭제되니 주기적으로 백업하세요.</div></div>';

    html += '</div>';
    main().innerHTML = html;

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(est => {
        const el = $('#st-storage');
        if (el) el.textContent = '브라우저 저장 공간: ' + (est.usage / 1024 / 1024).toFixed(1) + 'MB 사용 / ' +
          (est.quota / 1024 / 1024 / 1024).toFixed(1) + 'GB 할당';
      });
    }

    $('#st-lang').value = lang;
    $('#st-theme').value = theme;
    $('#st-lang').onchange = (e) => VN.db.setSetting('defaultLang', e.target.value);
    $('#st-theme').onchange = async (e) => {
      await VN.db.setSetting('theme', e.target.value);
      applyTheme(e.target.value);
    };
    $('#st-apikey-save').onclick = async () => {
      const v = $('#st-apikey').value.trim();
      if (!v) { toast('API 키를 입력하세요.'); return; }
      await VN.db.setSetting('geminiApiKey', v);
      toast('API 키를 저장했습니다.');
      viewSettings();
    };
    if ($('#st-apikey-del')) $('#st-apikey-del').onclick = async () => {
      await VN.db.setSetting('geminiApiKey', '');
      toast('API 키를 삭제했습니다.');
      viewSettings();
    };
    VN.db.setSetting('apiKey', ''); // 이전 버전의 API 키 설정값 정리
    /* Drive 설정 핸들러 */
    $('#dr-auto').onchange = (e) => VN.db.setSetting('driveAutoSave', e.target.checked);
    $('#dr-fmt').onchange = (e) => VN.db.setSetting('driveFormat', e.target.value);
    $('#dr-audio').onchange = (e) => VN.db.setSetting('driveAudio', e.target.checked);
    if ($('#dr-pick')) $('#dr-pick').onclick = async () => {
      try {
        const name = await VN.drive.pickFolder();
        toast('저장 폴더를 설정했습니다: ' + name);
        viewSettings();
      } catch (e) { if (!e || e.name !== 'AbortError') toast('폴더 선택 실패: ' + ((e && e.message) || e)); }
    };
    if ($('#dr-perm')) $('#dr-perm').onclick = async () => {
      const p = await VN.drive.requestFolderPermission();
      toast(p === 'granted' ? '폴더 접근이 승인되었습니다.' : '승인되지 않았습니다.');
      viewSettings();
    };
    if ($('#dr-unpick')) $('#dr-unpick').onclick = async () => {
      await VN.drive.clearFolder();
      toast('저장 폴더를 해제했습니다.');
      viewSettings();
    };
    $('#dr-hook-save').onclick = async () => {
      await VN.db.setSetting('appsScriptUrl', $('#dr-url').value.trim());
      await VN.db.setSetting('appsScriptToken', $('#dr-token').value.trim());
      toast('웹훅 설정을 저장했습니다.');
    };
    $$('input[name="dr-target"]').forEach(r => r.onchange = async (e) => {
      if (!e.target.checked) return;
      await VN.drive.setTarget(e.target.value);
      toast('저장 경로를 변경했습니다.');
    });

    /* 화자분리 API 키 (저장/삭제만 — 실제 호출은 VN.diarize 담당) */
    const KEY_SETTING = { 'st-dg-key': 'deepgramApiKey', 'st-aai-key': 'assemblyaiApiKey' };
    $$('[data-keysave]').forEach(b => b.onclick = async () => {
      const id = b.dataset.keysave;
      const v = $('#' + id).value.trim();
      if (!v) { toast('키를 입력하세요.'); return; }
      await VN.db.setSetting(KEY_SETTING[id], v);
      toast('키를 저장했습니다.');
      viewSettings();
    });
    $$('[data-keydel]').forEach(b => b.onclick = async () => {
      await VN.db.setSetting(KEY_SETTING[b.dataset.keydel], '');
      toast('키를 삭제했습니다.');
      viewSettings();
    });

    /* Google 계정 */
    $('#ga-clientid-save').onclick = async () => {
      await VN.gauth.setClientId($('#ga-clientid').value.trim());
      toast('클라이언트 ID를 저장했습니다.');
      viewSettings();
    };
    $('#ga-signin').onclick = async () => {
      const b = $('#ga-signin');
      b.disabled = true; b.textContent = '로그인 중…';
      try {
        await VN.gauth.signIn();
        toast('Google 계정에 로그인했습니다.');
      } catch (e) { toast('로그인 실패: ' + ((e && e.message) || e)); }
      viewSettings();
    };
    if ($('#ga-signout')) $('#ga-signout').onclick = async () => {
      await VN.gauth.signOut();
      toast('로그아웃했습니다.');
      viewSettings();
    };
    $('#ga-refolder').onclick = async () => {
      const b = $('#ga-refolder');
      b.disabled = true; b.textContent = '찾는 중…';
      try {
        const f = await VN.drive.resolveFolder(true);
        toast('Drive 폴더: ' + f.name);
      } catch (e) { toast('폴더 확인 실패: ' + ((e && e.message) || e)); }
      viewSettings();
    };
    $('#st-backup').onclick = async () => {
      const btn = $('#st-backup');
      btn.disabled = true; btn.textContent = '만드는 중…';
      try {
        await VN.exporter.downloadBackup($('#st-bk-audio').checked);
        toast('백업 파일을 내려받았습니다.');
      } catch (e) { toast('백업 실패: ' + (e.message || e)); }
      btn.disabled = false; btn.textContent = '백업 파일 다운로드';
    };
    $('#st-restore').onclick = () => $('#restore-input').click();
    $('#st-wipe').onclick = async () => {
      // 2단계 확인
      if (!await confirmModal('전체 삭제', '노트·폴더·휴지통·설정이 모두 삭제됩니다.', '계속', true)) return;
      const word = await promptModal('정말 삭제할까요?', '"삭제"라고 입력하면 진행합니다', '');
      if (word !== '삭제') { toast('입력이 일치하지 않아 취소했습니다.'); return; }
      await VN.db.wipeAll();
      toast('모든 데이터를 삭제했습니다.');
      go('#/list');
    };
    $('#st-demo').onclick = async () => {
      const btn = $('#st-demo');
      btn.disabled = true; btn.textContent = '생성 중…';
      try {
        const note = await VN.demo.seedDemo();
        toast('데모 노트를 만들었습니다.');
        go('#/note/' + note.id);
      } catch (e) {
        toast('데모 생성 실패: ' + (e.message || e));
        btn.disabled = false; btn.textContent = '데모 노트 생성';
      }
    };
  }

  /* ══════════════ 테마 ══════════════ */

  function applyTheme(theme) {
    S.theme = theme;
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  /* ══════════════ 초기화 ══════════════ */

  async function init() {
    // 테마
    const theme = await VN.db.getSetting('theme', 'system');
    applyTheme(theme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (S.theme === 'system') applyTheme('system');
    });

    // 사이드바 토글(모바일)
    $('#sidebar-toggle').onclick = () => $('#app').classList.toggle('sidebar-open');
    $('#sidebar-backdrop').onclick = () => $('#app').classList.remove('sidebar-open');

    // 상단 버튼
    $('#btn-new-record').onclick = () => go('#/record');
    $('#btn-import-file').onclick = () => $('#file-input').click();
    $('#file-input').onchange = (e) => { if (e.target.files.length) { importFiles(e.target.files); e.target.value = ''; } };
    $('#restore-input').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const r = await VN.db.restoreBackup(data);
        toast('복원 완료: 노트 ' + r.notes + '개, 폴더 ' + r.folders + '개');
        route();
      } catch (err) { toast('복원 실패: ' + (err.message || err)); }
    };

    // 드래그&드롭
    let dragDepth = 0, overlay = null;
    document.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer.items || [])].some(i => i.kind === 'file')) return;
      dragDepth++;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'drop-overlay';
        overlay.textContent = '오디오 파일을 놓아 노트 만들기';
        document.body.appendChild(overlay);
      }
    });
    document.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && overlay) { overlay.remove(); overlay = null; }
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      if (overlay) { overlay.remove(); overlay = null; }
      if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });

    // 녹음 중 새로고침·닫기 확인
    window.addEventListener('beforeunload', (e) => {
      if (S.rec && S.rec.active) { e.preventDefault(); e.returnValue = ''; }
    });

    // 탭 복귀: Wake Lock 재획득 + 백그라운드 STT 중단 감지.
    // 캡처 관련(MediaRecorder·STT·flush)은 여기서 아무것도 멈추지 않는다.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !S.rec || !S.rec.active) return;
      const wl = $('#rec-wakelock');
      if (wl && wl.checked) acquireWakeLock();
      if (VN.stt.supported && !S.rec.sttWarned && Date.now() - VN.stt.lastResultAt() > 60000) {
        S.rec.sttWarned = true;
        const warn = $('#rec-warn');
        if (warn) warn.innerHTML = '<div class="banner">백그라운드 동안 음성인식이 일부 중단됐을 수 있습니다. 녹음은 계속 저장되고 있으니, 저장 후 노트에서 "오디오 전체 재변환(Gemini)"으로 전체를 다시 전사할 수 있습니다.</div>';
      }
    });

    // 크래시 복구·Drive 권한 배너·웹훅 재시도 큐
    checkRecovery();
    checkDrivePermission();
    VN.drive.flushRetryQueue().then(r => {
      if (r.sent) toast('대기 중이던 Drive 웹훅 ' + r.sent + '건을 전송했습니다.');
    }).catch(() => { /* ignore */ });

    window.addEventListener('hashchange', route);
    await route();
  }

  return {
    init, route, go, toast, refresh,
    searchNotes, replaceInNote,        // 순수 함수 (셀프테스트용)
    importFiles,
    getState() {
      return {
        view: location.hash || '#/list',
        noteCount: S.notes.length,
        folderCount: S.folders.length,
        currentNoteId: S.note ? S.note.id : null,
        recording: !!(S.rec && S.rec.active)
      };
    }
  };
})();
