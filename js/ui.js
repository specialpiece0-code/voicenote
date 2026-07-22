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
    segSpeaker: null,          // null(전체) | 화자 인덱스 — 화자 필터 칩
    noteSearch: { q: '', matches: [], cur: -1 },
    noteSearchOpen: false,     // 노트 내 검색 바 표시 여부 (기본 숨김)
    noteReplOpen: false,       // 검색 바 안 "바꾸기" 2차 토글
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
    return (sp && sp.name) || U.speakerDefaultName(idx || 0);
  }
  function speakerColor(idx) { return COLORS[(idx || 0) % COLORS.length]; }

  function noteText(note) {
    return (note.segments || []).map(s => s.text || '').join(' ');
  }

  const LANG_LABEL = { 'ko-KR': '한국어', 'en-US': '영어', 'ja-JP': '일본어', 'zh-CN': '중국어' };

  /* ── 모바일 감지 (순수 함수: 셀프테스트에서 사용) ──
     모바일에서는 SpeechRecognition이 MediaRecorder와 마이크를 공유하지 못해
     실시간 자막 대신 녹음 종료 후 사후 전사를 안내한다.
     iPadOS 데스크톱 모드는 Macintosh UA + 멀티터치로 판별. */
  function isMobileUA(ua, touchPoints) {
    if (/Android|iPhone|iPad|iPod/i.test(ua || '')) return true;
    return /Macintosh/.test(ua || '') && (touchPoints || 0) > 1;
  }
  function isMobile() {
    return isMobileUA(navigator.userAgent, navigator.maxTouchPoints);
  }

  /* 노트·폴더 목록 메모리 캐시 — 저장 시점(invalidateNotesCache)에 무효화되고,
     외부 계층의 직접 DB 쓰기를 놓쳐도 1.5초 뒤엔 자동으로 다시 읽는다. */
  let notesCacheAt = 0;
  function invalidateNotesCache() { notesCacheAt = 0; }
  async function refresh(force) {
    if (!force && Date.now() - notesCacheAt < 1500) return;
    S.notes = await VN.db.getAllNotes();
    S.folders = await VN.db.getFolders();
    notesCacheAt = Date.now();
  }

  async function saveNote(note) { await VN.db.saveNote(note); invalidateNotesCache(); }

  /* 편집 중 여부 — 백그라운드 완료(전사·요약)로 화면을 통째로 다시 그리면 입력이 증발하므로 가드 */
  function isEditingDom() {
    const ae = document.activeElement;
    return !!(ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA'));
  }

  /* 노트 상세 인라인 파이프라인 배너 — 해당 노트를 보고 있을 때만 갱신, 성공 시 true */
  function setNotePipe(noteId, html) {
    if (!S.note || S.note.id !== noteId || !(location.hash || '').startsWith('#/note/')) return false;
    const el = $('#note-pipe');
    if (!el) return false;
    el.innerHTML = html ? '<div class="banner info">' + html + '</div>' : '';
    return true;
  }

  /* 카드 키보드 접근 (홈·검색 공용): Enter/Space로 열기 */
  function cardKeydown(open) {
    return (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  }

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

  /* ── Google 로그인 만료 배너 (Drive·캘린더 공용, 중복 표시 방지) ── */
  let authExpiredBanner = null;
  function notifyAuthExpired() {
    if (authExpiredBanner && authExpiredBanner.isConnected) return;
    authExpiredBanner = showTopBanner('Google 로그인이 만료되었습니다 — 설정에서 다시 로그인해 주세요.', [
      { label: '설정으로 이동', primary: true, onClick: () => { try { sessionStorage.setItem('advFocus', 'google'); } catch (e) { } go('#/settings/advanced'); } }
    ]);
  }

  /* ── 배포 감지: sw.js의 CACHE 버전 문자열을 메모리에 보관하고 주기 재조회 ──
     (하드코딩 상수 없음 — sw.js 캐시 버전을 올릴 때 이 코드는 손대지 않아도 된다) */
  let deployBaseVer = null;      // 페이지 로드 시점의 버전 (조회 실패 시 null → 감지 비활성)
  let deployNotified = false;
  let deployPendingWhileRec = false;
  async function fetchSwVersion() {
    try {
      const resp = await fetch('sw.js', { cache: 'no-store' });
      if (!resp.ok) return null;
      const m = (await resp.text()).match(/CACHE\s*=\s*'([^']+)'/);
      return m ? m[1] : null;
    } catch (e) { return null; } // 오프라인 등 — 무음 스킵
  }
  function showDeployBanner() {
    if (deployNotified) return;
    deployNotified = true;
    showTopBanner('새 버전이 배포되었습니다 — 새로고침', [
      { label: '새로고침', primary: true, onClick: () => location.reload() }
    ]);
  }
  async function checkDeploy() {
    if (deployBaseVer == null || deployNotified) return;
    const v = await fetchSwVersion();
    if (!v || v === deployBaseVer) return;
    if (S.rec && S.rec.active) { deployPendingWhileRec = true; return; } // 녹음 중엔 보류
    showDeployBanner();
  }
  function initDeployWatch() {
    fetchSwVersion().then(v => { deployBaseVer = v; });
    setInterval(checkDeploy, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkDeploy();
    });
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
        speakers: meta.speakers || [{ name: '참석A' }],
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
    // 녹음 중 이탈(뒤로가기 등) → 확인 게이트: 취소하면 녹음 화면으로 복귀
    if (S.rec && S.rec.active && !location.hash.startsWith('#/record')) {
      const ok = await confirmModal('녹음 진행 중',
        '녹음을 종료하고 저장할까요?<br><span class="muted small">취소하면 녹음 화면으로 돌아가 계속 녹음합니다.</span>',
        '종료하고 저장');
      if (!ok) { location.hash = '#/record'; return; } // 재진입은 resuming 경로 — 세션 유지
      const saved = await finishRecording(true);       // Drive 업로드는 내부에서 백그라운드 진행
      if (saved) toast('진행 중이던 녹음을 저장했습니다.');
    }
    // 플레이어 정리 (objectURL 누수 방지)
    if (S.player) { S.player.destroy(); S.player = null; }
    const hash = location.hash || '#/list';
    const parts = hash.slice(2).split('/');
    if (parts[0] !== 'record') document.body.classList.remove('on-record');
    await refresh();
    updateNav(hash);

    if (parts[0] === 'note' && parts[1]) await viewNote(parts[1]);
    else if (parts[0] === 'record') viewRecord();
    else if (parts[0] === 'settings') await (parts[1] === 'advanced' ? viewSettingsAdvanced() : viewSettings());
    else if (parts[0] === 'trash') await viewTrash();
    else if (parts[0] === 'search') viewSearch();
    else if (parts[0] === 'folder' && parts[1]) viewList({ folderId: parts[1] });
    else if (parts[0] === 'fav') viewList({ favorite: true });
    else viewList({});
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  /* ══════════════ 하단 내비게이션 ══════════════ */

  function updateNav(hash) {
    hash = hash || location.hash || '#/list';
    const s = $('#nav-search'), st = $('#nav-settings'), r = $('#nav-record');
    if (s) s.classList.toggle('active', hash.startsWith('#/search'));
    if (st) st.classList.toggle('active', hash.startsWith('#/settings'));
    if (r) r.classList.toggle('recording', !!(S.rec && S.rec.active));
  }

  /* ── 앵커 아래 드롭다운 메뉴 (홈·노트 ⋯ 공용) ──
     items: {icon,label,onClick,danger,checked} | {sep:true} | {head:'제목'} */
  function menuPop(anchor, items) {
    const back = document.createElement('div');
    back.className = 'menu-backdrop';
    const pop = document.createElement('div');
    pop.className = 'menu-pop';
    pop.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.sep) { const hr = document.createElement('div'); hr.className = 'menu-sep'; pop.appendChild(hr); continue; }
      if (it.head) { const hd = document.createElement('div'); hd.className = 'menu-head'; hd.textContent = it.head; pop.appendChild(hd); continue; }
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.innerHTML = '<span class="mi-icon">' + (it.icon || '') + '</span>' + U.esc(it.label) +
        (it.checked ? '<span class="mi-check">✓</span>' : '');
      if (it.danger) b.classList.add('danger');
      b.onclick = () => { back.remove(); if (it.onClick) it.onClick(); };
      pop.appendChild(b);
    }
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    back.appendChild(pop);
    document.body.appendChild(back);
    const r = anchor.getBoundingClientRect();
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    pop.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
    requestAnimationFrame(() => {   // 화면 아래로 넘치면 위로 밀어 올린다
      const pr = pop.getBoundingClientRect();
      if (pr.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, window.innerHeight - pr.height - 8) + 'px';
    });
    return back;
  }

  /* ── 폴더 생성·관리 (홈 필터 칩에서 진입) ── */
  async function addFolderFlow() {
    const name = await promptModal('새 폴더', '폴더 이름', '');
    if (!name) return;
    await VN.db.saveFolder({ name });
    invalidateNotesCache();
    toast('폴더를 만들었습니다.');
    route();
  }

  function folderManageModal(folder) {
    if (!folder) return;
    const m = modal('<h2>📁 ' + U.esc(folder.name) + '</h2><div class="modal-body">' +
      '<button class="btn btn-block" id="fo-ren" style="margin-bottom:8px">✏️ 이름 변경</button>' +
      '<button class="btn btn-block btn-danger" id="fo-del">🗑 폴더 삭제</button>' +
      '<p class="muted small" style="margin-top:10px">폴더를 삭제하면 안의 노트는 전체 노트로 이동합니다.</p></div>' +
      '<div class="modal-actions"><button class="btn" data-x="no">닫기</button></div>');
    $('[data-x="no"]', m).onclick = () => m.remove();
    $('#fo-ren', m).onclick = async () => {
      m.remove();
      const name = await promptModal('폴더 이름 변경', '폴더 이름', folder.name);
      if (!name) return;
      folder.name = name;
      await VN.db.saveFolder(folder);
      invalidateNotesCache();
      route();
    };
    $('#fo-del', m).onclick = async () => {
      m.remove();
      if (await confirmModal('폴더 삭제', '폴더를 삭제하면 안의 노트는 전체 노트로 이동합니다.', '삭제', true)) {
        await VN.db.deleteFolder(folder.id);
        invalidateNotesCache();
        go('#/list');
      }
    };
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
    const hash = location.hash || '#/list';
    const isOn = (h) => (h === '#/list' ? (hash === '' || hash === '#' || hash === '#/list') : hash === h);

    /* 상단 고정 헤더 + 가로 스크롤 필터 칩 */
    const chips =
      '<button class="filter-chip' + (isOn('#/list') ? ' on' : '') + '" data-go="#/list">전체</button>' +
      '<button class="filter-chip' + (isOn('#/fav') ? ' on' : '') + '" data-go="#/fav">⭐ 즐겨찾기</button>' +
      S.folders.map(f =>
        '<button class="filter-chip' + (isOn('#/folder/' + f.id) ? ' on' : '') + '" data-go="#/folder/' + f.id +
        '" data-folder="' + f.id + '">📁 ' + U.esc(f.name) +
        '<span class="chip-more">⋯</span></button>').join('') +
      '<button class="filter-chip" id="chip-add-folder" aria-label="폴더 추가">＋ 폴더</button>';

    main().innerHTML =
      '<div class="topbar"><div class="topbar-row">' +
      '<button class="home-logo" id="home-logo" aria-label="전체 노트로 이동"><span class="logo-dot"></span>보이스노트</button>' +
      '<div class="spacer"></div>' +
      '<button class="icon-btn plain" id="btn-import" aria-label="파일 불러오기">📂</button>' +
      '<button class="icon-btn plain" id="btn-home-more" aria-label="더보기 메뉴">⋯</button>' +
      '</div><div class="chip-row">' + chips + '</div></div>' +
      '<div class="view under-2"><div id="note-list"></div></div>';

    $('#home-logo').onclick = () => go('#/list');
    $('#btn-import').onclick = () => $('#file-input').click();
    $('#btn-home-more').onclick = (e) => {
      const setSort = (v) => { S.sort = v; renderCards(); };
      menuPop(e.currentTarget, [
        { icon: '🗑️', label: '휴지통', onClick: () => go('#/trash') },
        { sep: true }, { head: '정렬' },
        { icon: S.sort === 'recent' ? '•' : '', label: '최신순', checked: S.sort === 'recent', onClick: () => setSort('recent') },
        { icon: S.sort === 'title' ? '•' : '', label: '제목순', checked: S.sort === 'title', onClick: () => setSort('title') },
        { icon: S.sort === 'duration' ? '•' : '', label: '길이순', checked: S.sort === 'duration', onClick: () => setSort('duration') }
      ]);
    };

    /* 필터 칩 — 탭 이동, 현재 폴더 재탭·길게 누르면 이름변경·삭제 */
    $$('.chip-row .filter-chip').forEach(c => {
      const fid = c.dataset.folder;
      let lpTimer = null, lpFired = false;
      if (fid) {
        c.addEventListener('pointerdown', () => {
          lpFired = false;
          lpTimer = setTimeout(() => { lpFired = true; folderManageModal(S.folders.find(f => f.id === fid)); }, 550);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => c.addEventListener(ev, () => clearTimeout(lpTimer)));
      }
      c.onclick = () => {
        if (lpFired) { lpFired = false; return; }
        if (c.id === 'chip-add-folder') return addFolderFlow();
        if (fid && isOn(c.dataset.go)) return folderManageModal(S.folders.find(f => f.id === fid));
        go(c.dataset.go);
      };
    });

    const renderCards = () => {
      const results = sortNotes(notes);
      const list = $('#note-list');
      if (!results.length) {
        list.innerHTML = '<div class="empty-state"><div class="big">🎙️</div>' +
          (opts.favorite ? '즐겨찾기한 노트가 없습니다.'
            : folder ? '이 폴더에 노트가 없습니다.'
              : '노트가 없습니다.<br>첫 녹음을 시작해 보세요.') +
          '<div class="empty-actions">' +
          '<button class="btn btn-primary" id="empty-rec">● 첫 녹음 시작</button>' +
          '<button class="btn btn-outline" id="empty-import">파일 불러오기</button>' +
          '<button class="btn btn-outline" id="empty-demo">데모 노트로 둘러보기</button></div></div>';
        $('#empty-rec').onclick = () => go('#/record');
        $('#empty-import').onclick = () => $('#file-input').click();
        $('#empty-demo').onclick = async (e) => {
          e.target.disabled = true;
          try {
            const note = await VN.demo.seedDemo();
            invalidateNotesCache();
            go('#/note/' + note.id);
          } catch (err) { toast('데모 생성 실패: ' + ((err && err.message) || err)); e.target.disabled = false; }
        };
        return;
      }
      list.innerHTML = results.map(n => {
        const preview = n.transcribePending
          ? '<span class="pulse-soft">⏳ 텍스트 변환 중…</span>'
          : U.esc(noteText(n).slice(0, 90) || '(아직 텍스트가 없어요)');
        const fname = n.folderId ? (S.folders.find(f => f.id === n.folderId) || {}).name : null;
        return '<div class="note-card" data-id="' + n.id + '" role="button" tabindex="0">' +
          '<div class="nc-title">' + U.esc(n.title || '제목 없음') + '</div>' +
          '<div class="nc-preview">' + preview + '</div>' +
          '<div class="nc-meta"><span>' + U.fmtDate(n.createdAt) + '</span><span>⏱ ' + U.fmtTime(n.duration) + '</span>' +
          (fname ? '<span class="tag">📁 ' + U.esc(fname) + '</span>' : '') +
          (n.tags || []).map(t => '<span class="tag green">#' + U.esc(t) + '</span>').join('') +
          (n.audioBlob ? '' : '<span class="tag">오디오 없음</span>') + '</div>' +
          '<button class="nc-star' + (n.favorite ? ' on' : '') + '" data-star="' + n.id + '" aria-label="즐겨찾기">' +
          (n.favorite ? '★' : '☆') + '</button></div>';
      }).join('');
      $$('.note-card', list).forEach(c => {
        const open = () => go('#/note/' + c.dataset.id);
        c.onclick = (e) => { if (e.target.closest('.nc-star')) return; open(); };
        c.onkeydown = cardKeydown(open);
      });
      $$('.nc-star', list).forEach(b => b.onclick = async (e) => {
        e.stopPropagation();
        const n = S.notes.find(x => x.id === b.dataset.star);
        if (!n) return;
        n.favorite = !n.favorite;
        await saveNote(n);
        if (opts.favorite) notes = S.notes.filter(x => x.favorite);
        renderCards();
      });
    };
    renderCards();
  }

  /* ══════════════ 전역 검색 화면 ══════════════ */

  function viewSearch() {
    main().innerHTML =
      '<div class="topbar"><div class="topbar-row">' +
      '<button class="icon-btn plain" id="sr-back" aria-label="뒤로">←</button>' +
      '<div class="searchbar"><input type="search" id="sr-q" placeholder="노트 검색 (제목·본문·메모)" value="' +
      U.esc(S.listQuery) + '" aria-label="검색어"></div>' +
      '</div></div>' +
      '<div class="view under-1"><div id="sr-results"></div></div>';
    $('#sr-back').onclick = () => go('#/list');

    const cardHtml = (n, q, snippet) =>
      '<div class="note-card" data-id="' + n.id + '" role="button" tabindex="0">' +
      '<div class="nc-title">' + markText(n.title || '제목 없음', q) + '</div>' +
      (snippet ? '<div class="search-snippet">' + markText(snippet, q) + '</div>' : '') +
      '<div class="nc-meta"><span>' + U.fmtDate(n.createdAt) + '</span><span>⏱ ' + U.fmtTime(n.duration) + '</span></div>' +
      '</div>';
    const bindCards = (box, jumpQ) => {
      $$('.note-card', box).forEach(c => {
        const open = () => {
          if (jumpQ) S.pendingJump = jumpQ;
          go('#/note/' + c.dataset.id);
        };
        c.onclick = open;
        c.onkeydown = cardKeydown(open);
      });
    };
    const renderResults = () => {
      const q = S.listQuery.trim();
      const box = $('#sr-results');
      if (!box) return;
      if (!q) {
        // 빈 검색어: 최근 노트 3개로 바로 진입할 수 있게
        const recent = S.notes.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
        box.innerHTML = recent.length
          ? '<div class="muted small" style="margin-bottom:8px">최근 노트</div>' +
            recent.map(n => cardHtml(n, '', null)).join('')
          : '<div class="empty-state"><div class="big">🔍</div>노트 제목·본문·메모에서 검색합니다.</div>';
        bindCards(box, null);
        return;
      }
      const results = searchNotes(sortNotes(S.notes), q);
      if (!results.length) {
        box.innerHTML = '<div class="empty-state"><div class="big">🔍</div>"' + U.esc(q) + '" 검색 결과가 없습니다.</div>';
        return;
      }
      box.innerHTML = '<div class="muted small" style="margin-bottom:8px">노트 ' + results.length + '개</div>' +
        results.map(({ note: n, snippet }) => cardHtml(n, q, snippet)).join('');
      bindCards(box, q);
    };
    renderResults();
    const input = $('#sr-q');
    input.focus();
    input.oninput = U.debounce((e) => { S.listQuery = e.target.value; renderResults(); }, 200);
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
  }

  /* ══════════════ 노트 상세 ══════════════ */

  async function viewNote(id) {
    // route()를 거치지 않는 직접 호출(재변환·일정 연결 후 등)에서도 ObjectURL 누수가 없도록 정리
    if (S.player) { S.player.destroy(); S.player = null; }
    const note = await VN.db.getNote(id);
    if (!note) { toast('노트를 찾을 수 없습니다.'); go('#/list'); return; }
    S.note = note;
    S.noteTab = 'seg';
    S.segFilter = 'all';
    S.segSpeaker = null;
    S.noteSearch = { q: '', matches: [], cur: -1 };
    S.noteSearchOpen = false;
    S.noteReplOpen = false;
    S.editingSeg = null;

    const hasAudio = note.audioBlob instanceof Blob;
    const folderName = note.folderId ? ((S.folders.find(f => f.id === note.folderId) || {}).name || null) : null;

    /* 상단 고정 앱바(←·제목·⋯) + 고정 세그먼트 탭 */
    let html = '<div class="topbar"><div class="topbar-row">' +
      '<button class="icon-btn plain" id="btn-back" aria-label="목록으로">←</button>' +
      '<input class="note-title-input" id="note-title" value="' + U.esc(note.title) + '" aria-label="노트 제목">' +
      '<button class="icon-btn plain" id="btn-more" aria-label="더보기 메뉴">⋯</button>' +
      '</div>' +
      '<div class="tabs" role="tablist" aria-label="노트 탭">' +
      '<button class="tab active" role="tab" aria-selected="true" data-tab="seg">음성 기록</button>' +
      '<button class="tab" role="tab" aria-selected="false" data-tab="ai">AI 요약</button>' +
      '<button class="tab" role="tab" aria-selected="false" data-tab="memo">메모 <span class="faint">' + (note.memos || []).length + '</span></button>' +
      '</div></div>';

    html += '<div class="view under-2' + (hasAudio ? ' with-player' : '') + '">' +
      '<div class="note-info">' +
      '<span>' + U.fmtDate(note.createdAt) + '</span>' +
      '<span>⏱ ' + U.fmtTime(note.duration) + '</span>' +
      '<span>' + (LANG_LABEL[note.language] || note.language || '-') + '</span>' +
      (folderName ? '<span>📁 ' + U.esc(folderName) + '</span>' : '') +
      (note.tags || []).map(t => '<span class="tag green">#' + U.esc(t) + '</span>').join('') +
      (note.calendar && note.calendar.title ? '<span title="연결된 일정">📅 ' + U.esc(note.calendar.title) + '</span>' : '') +
      (note.driveLink && /^https:\/\//.test(note.driveLink)
        ? '<span><a href="' + U.esc(note.driveLink) + '" target="_blank" rel="noopener">Drive에서 열기 ↗</a></span>' : '') +
      '</div>' +
      (hasAudio ? '' : '<div class="banner info">이 노트에는 오디오가 없습니다.</div>') +
      /* 백그라운드 파이프라인(변환→AI 정리→Drive) 인라인 상태 — 토스트 대신 여기서 갱신 */
      '<div id="note-pipe">' +
      (note.transcribePending ? '<div class="banner info">⏳ 자동 텍스트 변환 중 — 화면을 이동해도 계속됩니다.</div>' : '') +
      '</div>' +
      '<div id="tab-body"></div></div>';

    /* 하단 고정 플레이어 바 (내비 위) — 스크롤 중에도 항상 조작 가능 */
    if (hasAudio) {
      html += '<div class="player-dock">' +
        '<canvas class="player-wave" id="pl-wave" aria-label="파형 시크바"></canvas>' +
        '<div class="player-controls">' +
        '<button class="btn-play" id="pl-toggle" aria-label="재생/일시정지">▶</button>' +
        '<button class="icon-btn" id="pl-back10" aria-label="10초 뒤로">⟲10</button>' +
        '<button class="icon-btn" id="pl-fwd10" aria-label="10초 앞으로">10⟳</button>' +
        '<button class="icon-btn" id="pl-speed" aria-label="배속">1.0×</button>' +
        '<button class="icon-btn" id="pl-ab" aria-label="A-B 구간 반복">A-B</button>' +
        '<span class="player-time" id="pl-time">00:00 / ' + U.fmtTime(note.duration) + '</span>' +
        '</div></div>' +
        '<audio id="note-audio" preload="metadata" style="display:none"></audio>';
    }

    main().innerHTML = html;

    /* 앱바 이벤트 */
    $('#btn-back').onclick = () => go('#/list');
    $('#note-title').onchange = async (e) => { note.title = e.target.value.trim() || '제목 없음'; await saveNote(note); };
    $('#btn-more').onclick = (e) => noteMenu(note, e.currentTarget);

    /* 플레이어 */
    if (hasAudio) {
      const audioEl = $('#note-audio');
      S.player = VN.player.create(audioEl, note, {
        onTime: (t) => {
          $('#pl-time') && ($('#pl-time').textContent = U.fmtTime(t) + ' / ' + U.fmtTime(S.player.duration));
          const mb = $('#memo-t-badge');
          if (mb) mb.textContent = '⏱ ' + U.fmtTime(t);
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
        // 토스트 없이 버튼 라벨·상태로만 피드백 (A-? → A-B 켜짐 → 해제)
        const st = S.player.toggleAB();
        const b = $('#pl-ab');
        if (st === 'A') { b.textContent = 'A-?'; b.classList.add('on'); }
        else if (st === 'B') { b.textContent = 'A-B'; b.classList.add('on'); }
        else { b.textContent = 'A-B'; b.classList.remove('on'); }
      };
    }

    $$('.tab').forEach(t => t.onclick = () => {
      $$('.tab').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
      t.classList.add('active');
      t.setAttribute('aria-selected', 'true');
      S.noteTab = t.dataset.tab;
      renderTabBody(note);
    });
    renderTabBody(note);

    // 전역 검색에서 온 점프 — 노트 내 검색 바 자동 열기
    if (S.pendingJump) {
      const q = S.pendingJump; S.pendingJump = null;
      S.noteSearch.q = q;
      S.noteSearchOpen = true;
      renderTabBody(note);
      setTimeout(() => jumpToMatch(0), 100);
    }
  }

  /* ── 노트 ⋯ 메뉴 — 공유·다운로드·Drive·일정·재변환·폴더 이동·즐겨찾기·삭제 ── */
  function noteMenu(note, anchor) {
    const hasAudio = note.audioBlob instanceof Blob;
    const items = [
      {
        icon: note.favorite ? '★' : '☆', label: note.favorite ? '즐겨찾기 해제' : '즐겨찾기',
        onClick: async () => {
          note.favorite = !note.favorite;
          await saveNote(note);
        }
      },
      { icon: '↗', label: '공유', onClick: () => shareModal(note) },
      { icon: '⬇', label: '다운로드', onClick: () => exportModal(note) },
      { icon: '☁', label: 'Drive 저장', onClick: () => driveSaveNow(note) }
    ];
    if (note.driveLink && /^https:\/\//.test(note.driveLink)) {
      items.push({ icon: '🔗', label: 'Drive에서 열기', onClick: () => window.open(note.driveLink, '_blank', 'noopener') });
    }
    items.push({
      icon: '📅', label: '일정 연결',
      onClick: async () => {
        let ok = false;
        try { ok = await VN.gcal.available(); } catch (e) { ok = false; }
        if (!ok) { toast('설정에서 Google 로그인 후 사용할 수 있습니다.'); return; }
        calendarLinkModal(note);
      }
    });
    if (hasAudio) items.push({ icon: '🎤', label: '다시 변환', onClick: () => retranscribeMenu(note) });
    items.push({ icon: '📁', label: '폴더 이동', onClick: () => folderMoveModal(note) });
    items.push({ sep: true });
    items.push({ icon: '🗑', label: '삭제', danger: true, onClick: () => deleteNoteFlow(note) });
    menuPop(anchor, items);
  }

  async function driveSaveNow(note) {
    toast('Drive 저장 중…');
    try {
      const r = await VN.drive.saveNoteToDrive(note);
      toast(r.message || (r.saved ? 'Drive에 저장했습니다.' : 'Drive 저장을 건너뛰었습니다.'));
      if (r.titleChanged && $('#note-title')) $('#note-title').value = note.title;
      if (r.authExpired) notifyAuthExpired();
    } catch (e) { toast('Drive 저장 실패: ' + (e.message || e)); }
  }

  async function deleteNoteFlow(note) {
    if (await confirmModal('노트 삭제', '휴지통으로 이동합니다. 30일 후 자동으로 영구 삭제됩니다.', '삭제', true)) {
      if (S.player) { S.player.destroy(); S.player = null; }
      await VN.db.trashNote(note.id);
      invalidateNotesCache();
      toast('휴지통으로 이동했습니다.');
      go('#/list');
    }
  }

  function folderMoveModal(note) {
    const m = modal('<h2>📁 폴더 이동</h2><div class="modal-body"><div class="form-row"><label>폴더</label>' +
      '<select id="fm-sel"><option value="">전체 노트 (폴더 없음)</option>' +
      S.folders.map(f => '<option value="' + f.id + '"' + (note.folderId === f.id ? ' selected' : '') + '>' + U.esc(f.name) + '</option>').join('') +
      '</select></div></div>' +
      '<div class="modal-actions"><button class="btn" data-x="no">취소</button><button class="btn btn-primary" data-x="ok">이동</button></div>');
    $('[data-x="no"]', m).onclick = () => m.remove();
    $('[data-x="ok"]', m).onclick = async () => {
      note.folderId = $('#fm-sel', m).value || null;
      await saveNote(note);
      m.remove();
      toast('폴더를 이동했습니다.');
      viewNote(note.id);
    };
  }

  /* ── 참석자: 발화 비율 차트(AI 요약 탭 하단) + 이름 변경·병합 모달(음성 기록 탭 도구) ── */
  function usedSpeakerIdxs(note) {
    if (!(note.speakers || []).length) note.speakers = [{ name: '참석A' }];
    return [...new Set((note.segments || []).map(s => s.speaker || 0))].sort((a, b) => a - b);
  }

  function speakerChartHtml(note) {
    const idxs = usedSpeakerIdxs(note);
    const totals = {};
    let grand = 0;
    for (const s of (note.segments || [])) {
      const d = Math.max(0.5, (s.end || s.start) - s.start);
      totals[s.speaker || 0] = (totals[s.speaker || 0] || 0) + d;
      grand += d;
    }
    let legend = '<div class="speaker-legend">';
    for (const i of idxs) {
      legend += '<span class="sp"><span class="sp-dot" style="background:' + speakerColor(i) + '"></span>' +
        U.esc(speakerName(note, i)) + ' <span class="faint">' + (grand ? Math.round((totals[i] || 0) / grand * 100) : 0) + '%</span></span>';
    }
    legend += '</div>';
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
    return legend + svg;
  }

  function speakersEditModal(note) {
    const idxs = usedSpeakerIdxs(note);
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
      renderTabBody(note);
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
    if (S.segSpeaker != null) segs = segs.filter(x => (x.s.speaker || 0) === S.segSpeaker);
    return segs;
  }

  function renderSegTab(note) {
    const body = $('#tab-body');
    let html = '';
    // 자동 변환 진행 배너는 탭 공통 영역(#note-pipe)에서 표시 — 여기서는 오류·재시도만
    if (note.transcribeError) {
      html += '<div class="banner">' + U.esc(note.transcribeError) +
        ' <button class="btn btn-sm btn-primary" id="btn-tr-retry" style="margin-left:8px">다시 시도</button></div>';
    }
    /* 화자 필터 칩 — 화자가 2명 이상일 때만 표시 */
    const usedSp = [...new Set((note.segments || []).map(s => s.speaker || 0))].sort((a, b) => a - b);
    const spChips = usedSp.length >= 2 ? usedSp.map(i =>
      '<button class="filter-chip' + (S.segSpeaker === i ? ' on' : '') + '" data-sp-f="' + i + '">' +
      '<span class="sp-dot" style="background:' + speakerColor(i) + '"></span>' + U.esc(speakerName(note, i)) + '</button>'
    ).join('') : '';
    /* 검색·바꾸기 바는 기본 숨김 — 🔍 토글로 열고, "바꾸기"는 그 안의 2차 토글 */
    const searchOpen = S.noteSearchOpen || !!S.noteSearch.q.trim();
    html += '<div class="seg-toolbar">' +
      '<button class="filter-chip' + (S.segFilter === 'all' ? ' on' : '') + '" data-f="all">전체</button>' +
      '<button class="filter-chip' + (S.segFilter === 'bookmark' ? ' on' : '') + '" data-f="bookmark">🔖 북마크만</button>' +
      '<button class="filter-chip' + (S.segFilter === 'highlight' ? ' on' : '') + '" data-f="highlight">🖍 하이라이트만</button>' +
      spChips +
      '<div class="spacer" style="flex:1"></div>' +
      '<button class="icon-btn' + (searchOpen ? ' on' : '') + '" id="btn-ns-toggle" aria-label="노트 내 검색" aria-expanded="' + searchOpen + '">🔍</button>' +
      '<button class="btn btn-sm btn-outline" id="btn-speakers-edit" aria-label="참석자 이름 변경·병합">👥 참석자</button>' +
      '<button class="btn btn-sm btn-outline" id="btn-add-seg">＋ 구간 추가</button>' +
      '</div>';
    if (searchOpen) {
      html += '<div class="note-search-bar">' +
        '<input type="search" id="ns-q" placeholder="노트 내 검색" value="' + U.esc(S.noteSearch.q) + '">' +
        '<button class="icon-btn" id="ns-prev" title="이전">↑</button>' +
        '<button class="icon-btn" id="ns-next" title="다음">↓</button>' +
        '<span class="match-info" id="ns-info"></span>' +
        '<button class="btn btn-sm' + (S.noteReplOpen ? ' btn-outline' : '') + '" id="ns-repl-toggle">바꾸기</button>' +
        (S.noteReplOpen
          ? '<input type="text" id="ns-repl" placeholder="바꿀 내용">' +
            '<button class="btn btn-sm" id="ns-replace">한 번에 바꾸기</button>'
          : '') +
        '</div>';
    }

    // 녹음 중 찍은 시점 북마크 칩
    if ((note.bookmarks || []).length) {
      html += '<div class="bm-chips">' + note.bookmarks.map(b =>
        '<button class="filter-chip" data-bm-time="' + b.time + '">🔖 ' + U.fmtTime(b.time) + '</button>').join('') + '</div>';
    }

    html += '<div id="seg-list"></div>';
    body.innerHTML = html;

    renderSegList(note);

    if ($('#btn-tr-retry')) $('#btn-tr-retry').onclick = async () => {
      const r = await VN.transcribe.start(note);
      if (!r.started && r.reason === 'no-keys') {
        try { sessionStorage.setItem('advFocus', 'gemini'); } catch (e) { }
        go('#/settings/advanced');
      }
    };

    $$('.filter-chip[data-f]', body).forEach(c => c.onclick = () => { S.segFilter = c.dataset.f; renderSegTab(note); });
    $$('[data-sp-f]', body).forEach(c => c.onclick = () => {
      const i = +c.dataset.spF;
      S.segSpeaker = (S.segSpeaker === i) ? null : i; // 재탭하면 해제
      renderSegTab(note);
    });
    $$('[data-bm-time]', body).forEach(c => c.onclick = () => { if (S.player) S.player.playFrom(+c.dataset.bmTime); });

    $('#btn-speakers-edit').onclick = () => speakersEditModal(note);
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

    /* 🔍 토글 — 닫으면 검색 상태도 초기화 */
    $('#btn-ns-toggle').onclick = () => {
      const nowOpen = !(S.noteSearchOpen || !!S.noteSearch.q.trim());
      S.noteSearchOpen = nowOpen;
      if (!nowOpen) { S.noteSearch = { q: '', matches: [], cur: -1 }; S.noteReplOpen = false; }
      renderSegTab(note);
      if (nowOpen) { const i = $('#ns-q'); if (i) i.focus(); }
    };

    if (searchOpen) {
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
      $('#ns-repl-toggle').onclick = () => {
        S.noteReplOpen = !S.noteReplOpen;
        S.noteSearchOpen = true;
        renderSegTab(note);
      };
      if ($('#ns-replace')) $('#ns-replace').onclick = async () => {
        const find = $('#ns-q').value.trim();
        const repl = $('#ns-repl').value;
        if (!find) { toast('바꿀 검색어를 입력하세요.'); return; }
        const n = replaceInNote(note, find, repl);
        if (n > 0) { await saveNote(note); toast(n + '건을 바꿨습니다.'); doSearch(); }
        else toast('일치하는 내용이 없습니다.');
      };
      if (S.noteSearch.q) doSearch();
    }
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
        (S.segFilter !== 'all' ? '<br><span class="small">필터를 해제해 보세요.</span>' : '<br><span class="small">"구간 추가"를 눌러 내용을 직접 적을 수 있어요.</span>') + '</div>';
      return;
    }
    const q = S.noteSearch.q.trim();
    /* 상시 버튼은 북마크·하이라이트 2개 — 편집은 텍스트 탭, 편집·삭제는 롱프레스 메뉴 */
    list.innerHTML = segs.map(({ s, i }) => {
      const name = speakerName(note, s.speaker);
      return '<div class="segment' + (s.highlighted ? ' hl' : '') + '" data-seg-idx="' + i + '">' +
        '<div class="seg-avatar" style="background:' + speakerColor(s.speaker) + '">' + U.esc(U.speakerInitial(name)) + '</div>' +
        '<div class="seg-body"><div class="seg-head">' +
        '<span>' + U.esc(name) + '</span>' +
        '<span class="seg-time" data-t="' + s.start + '" title="이 지점부터 재생">' + U.fmtTime(s.start) + '</span>' +
        '<span class="seg-actions">' +
        '<button data-act="bm" class="' + (s.bookmarked ? 'on' : '') + '" title="북마크">' + (s.bookmarked ? '🔖' : '📑') + '</button>' +
        '<button data-act="hl" class="' + (s.highlighted ? 'on' : '') + '" title="하이라이트">🖍</button>' +
        '</span></div>' +
        '<div class="seg-text" data-text-idx="' + i + '" title="탭하여 편집">' + (q ? markText(s.text || '', q) : U.esc(s.text || '')) + '</div>' +
        '</div></div>';
    }).join('');

    $$('.seg-time', list).forEach(el => el.onclick = () => { if (S.player) S.player.playFrom(+el.dataset.t); });
    const deleteSeg = async (i) => {
      if (await confirmModal('구간 삭제', '이 구간을 삭제할까요?', '삭제', true)) {
        note.segments.splice(i, 1);
        await saveNote(note);
        renderSegTab(note);
      }
    };
    $$('.segment', list).forEach(row => {
      const i = +row.dataset.segIdx;
      const s = note.segments[i];
      $$('button[data-act]', row).forEach(b => b.onclick = async (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'bm') { s.bookmarked = !s.bookmarked; await saveNote(note); renderSegList(note); }
        else if (act === 'hl') { s.highlighted = !s.highlighted; await saveNote(note); renderSegList(note); }
      });
      // 텍스트 탭 → 바로 편집
      const textEl = $('.seg-text', row);
      if (textEl) textEl.onclick = () => { if (!textEl.isContentEditable) startEditSegment(note, i); };
      // 롱프레스(550ms) → 편집·삭제 메뉴 (스크롤 이동 시 취소)
      let lpTimer = null, lpX = 0, lpY = 0;
      row.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        lpX = e.clientX; lpY = e.clientY;
        lpTimer = setTimeout(() => {
          lpTimer = null;
          menuPop(row, [
            { icon: '✎', label: '편집', onClick: () => startEditSegment(note, i) },
            { icon: '🗑', label: '삭제', danger: true, onClick: () => deleteSeg(i) }
          ]);
        }, 550);
      });
      row.addEventListener('pointermove', (e) => {
        if (lpTimer && (Math.abs(e.clientX - lpX) > 10 || Math.abs(e.clientY - lpY) > 10)) { clearTimeout(lpTimer); lpTimer = null; }
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
        row.addEventListener(ev, () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }));
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

  /* 재생 동기: 현재 세그먼트 하이라이트 + 자동 스크롤
     — 사용자가 직접 스크롤한 뒤 4초간은 자동 스크롤을 멈춘다 (하이라이트는 유지) */
  let lastCurrentIdx = -1;
  let userScrolledAt = 0;
  window.addEventListener('wheel', () => { userScrolledAt = Date.now(); }, { passive: true });
  window.addEventListener('touchmove', () => { userScrolledAt = Date.now(); }, { passive: true });
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
        if (Date.now() - userScrolledAt > 4000) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  /* ── 메모 탭 ── */
  function renderMemoTab(note) {
    const body = $('#tab-body');
    const curT = S.player ? S.player.currentTime : 0;
    let html = '<div class="record-memo-row" style="margin-bottom:14px;align-items:center">' +
      '<span class="tag" id="memo-t-badge" title="현재 재생 시점">⏱ ' + U.fmtTime(curT) + '</span>' +
      '<input type="text" id="memo-new" placeholder="이 시점에 메모 남기기">' +
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

  /* ── 마인드맵 SVG 렌더 (레이아웃 계산은 VN.summarizer.mindmapLayout 순수 함수) ── */
  function mindmapSVG(lay) {
    if (!lay || !lay.nodes.length) return '';
    let s = '<svg class="mindmap-svg" width="' + lay.width + '" height="' + lay.height +
      '" viewBox="0 0 ' + lay.width + ' ' + lay.height + '" role="img" aria-label="마인드맵">';
    for (const l of lay.links) {
      const mx = (l.x1 + l.x2) / 2;
      s += '<path d="M' + l.x1 + ' ' + l.y1 + ' C' + mx + ' ' + l.y1 + ', ' + mx + ' ' + l.y2 + ', ' +
        l.x2 + ' ' + l.y2 + '" fill="none" stroke="var(--border)" stroke-width="1.5"/>';
    }
    for (const n of lay.nodes) {
      const root = n.depth === 0;
      s += '<rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="9" fill="' +
        (root ? 'var(--green)' : (n.depth === 1 ? 'var(--green-soft)' : 'var(--bg-sub)')) +
        '" stroke="' + (root ? 'var(--green)' : 'var(--border)') + '"/>';
      n.lines.forEach((ln, i) => {
        s += '<text x="' + (n.x + n.w / 2) + '" y="' + (n.y + 20 + 18 * i) + '" text-anchor="middle" font-size="13" fill="' +
          (root ? '#fff' : 'var(--text)') + '">' + U.esc(ln) + '</text>';
      });
    }
    return s + '</svg>';
  }

  /* ── AI 요약 탭 ── */
  function renderAiTab(note) {
    const body = $('#tab-body');
    const s = note.summary;
    let html = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">' +
      '<button class="btn btn-primary" id="btn-ai-run">' + (s ? 'AI 정리 다시 생성' : 'AI 정리 생성') + '</button>' +
      '<span class="muted small" id="ai-mode-info"></span></div><div id="ai-result"></div>' +
      /* Ask AI — 요약 유무와 무관하게 항상 표시 */
      '<div class="ai-block" id="ask-ai" style="margin-top:16px"><h3><span class="dot"></span>AI에게 질문</h3>' +
      '<div id="ask-history"></div>' +
      '<div class="record-memo-row" style="margin-top:8px">' +
      '<input type="text" id="ask-q" placeholder="이 녹음 내용에 대해 질문하세요">' +
      '<button class="btn btn-primary" id="ask-send">보내기</button></div></div>' +
      /* 참석자별 발화 비율 차트 — AI 요약 탭 하단 */
      '<div class="ai-block"><h3><span class="dot"></span>참석자 · 발화 비율</h3>' + speakerChartHtml(note) + '</div>';
    body.innerHTML = html;

    /* Ask AI: 질문·답변 이력(노트에 최근 20개 저장) */
    const renderAskHistory = () => {
      const box = $('#ask-history');
      if (!box) return;
      const hist = note.askHistory || [];
      box.innerHTML = hist.length
        ? hist.slice().reverse().map(it =>
            '<div class="ask-item"><div class="ask-q">Q. ' + U.esc(it.q) + '</div>' +
            '<div class="ask-a">' + U.esc(it.a) + '</div>' +
            '<div class="faint small" style="margin-top:4px">' + U.fmtDate(it.at) + '</div></div>').join('')
        : '<p class="muted small">이 녹음의 전체 내용과 메모를 바탕으로 AI가 답합니다. 질문·답변은 이 노트에 저장됩니다.</p>';
    };
    renderAskHistory();
    const sendAsk = async () => {
      const q = ($('#ask-q') && $('#ask-q').value.trim()) || '';
      if (!q) return;
      const btn = $('#ask-send');
      btn.disabled = true; btn.textContent = '답변 중…';
      try {
        const a = await VN.summarizer.ask(note, q, (n, total) => {
          const b = $('#ask-send');
          if (b) b.textContent = '재시도 ' + n + '/' + total + '…';
        });
        note.askHistory = ((note.askHistory || []).concat([{ q, a, at: Date.now() }])).slice(-20);
        await saveNote(note);
        if ($('#ask-q')) $('#ask-q').value = '';
        renderAskHistory();
      } catch (e) {
        if (e && e.code === 'no-key') toast('Gemini API 키가 필요합니다 — 설정 → 고급 설정의 AI 요약 엔진 (Gemini)에서 등록하세요.', 5000);
        else toast('답변 실패: ' + ((e && e.message) || e));
      }
      const b = $('#ask-send');
      if (b) { b.disabled = false; b.textContent = '보내기'; }
    };
    $('#ask-send').onclick = sendAsk;
    $('#ask-q').onkeydown = (e) => { if (e.key === 'Enter') sendAsk(); };
    Promise.all([
      VN.db.getSetting('geminiApiKey', ''),
      VN.db.getSetting('geminiModel', VN.summarizer.DEFAULT_MODEL)
    ]).then(([k, m]) => {
      const label = VN.summarizer.SUMMARY_MODELS.indexOf(m) !== -1 ? m : VN.summarizer.DEFAULT_MODEL;
      $('#ai-mode-info') && ($('#ai-mode-info').textContent = k ? '고급 모드(' + label + ') (실패 시 기본 모드 폴백)' : '기본 모드 — 인터넷 없이 만드는 간단 요약');
    });

    const renderResult = () => {
      const el = $('#ai-result');
      if (!el) return; // 생성 완료 전에 다른 화면으로 이탈 — 결과는 이미 노트에 저장돼 있다
      if (!note.summary) { el.innerHTML = '<div class="empty-state">버튼을 눌러 대화 유형에 맞는 요약·마인드맵·할 일·키워드를 생성하세요.<br><span class="small">모든 결과는 클릭해서 편집할 수 있습니다.</span></div>'; return; }
      // 구형 저장분(문자열 todos·고정 필드)도 같은 형태로 다루도록 메모리상에서만 정규화
      const sum = VN.summarizer.normalizeSummary(note.summary);
      note.summary = sum;
      /* 신형(적응형) 요약인지 — 구형은 기존 고정 레이아웃 그대로 렌더 (하위 호환) */
      const isNew = !!(sum.type || sum.sections.length || sum.mindmap);
      let h = '';
      if (sum.fallbackReason) h += '<div class="banner">' + U.esc(sum.fallbackReason) + '</div>';
      h += '<div class="ai-block"><h3><span class="dot"></span>요약 ' +
        (sum.type ? '<span class="tag green">' + U.esc(sum.type) + '</span> ' : '') +
        '<span class="faint small">(' + (sum.mode === 'gemini' ? 'Gemini' : '기본') + ')</span></h3>' +
        '<div class="ai-editable" id="ai-summary" contenteditable="true">' + U.esc(sum.summary || '') + '</div></div>';
      /* 적응형 섹션 — 모델이 대화 유형에 맞게 구성한 것 (항목 편집·삭제 가능) */
      sum.sections.forEach((sec, si) => {
        h += '<div class="ai-block"><h3><span class="dot"></span>' + U.esc(sec.title || '섹션') + '</h3><ul>' +
          sec.items.map((it, ii) =>
            '<li><span class="ai-editable" contenteditable="true" data-sec="' + si + '" data-sitem="' + ii + '">' + U.esc(it) + '</span> ' +
            '<button class="icon-btn btn-sm" data-sec-del="' + si + '" data-sitem="' + ii + '" style="padding:1px 6px">✕</button></li>'
          ).join('') + '</ul></div>';
      });
      /* 마인드맵 — 신형 요약에만 존재, 모바일은 가로 스크롤 */
      if (sum.mindmap) {
        h += '<div class="ai-block"><h3><span class="dot"></span>마인드맵</h3>' +
          '<div class="mindmap-scroll">' + mindmapSVG(VN.summarizer.mindmapLayout(sum.mindmap)) + '</div></div>';
      }
      /* 결정 사항 / 미결 안건 — 신형은 실제로 있을 때만, 구형은 기존처럼 항상 표시 */
      const simpleList = (title, key, items) =>
        '<div class="ai-block"><h3><span class="dot"></span>' + title + '</h3><ul>' + items.map((x, i) =>
          '<li><span class="ai-editable" contenteditable="true" data-list="' + key + '" data-idx="' + i + '">' + U.esc(x) + '</span> ' +
          '<button class="icon-btn btn-sm" data-list-del="' + key + '" data-idx="' + i + '" style="padding:1px 6px">✕</button></li>'
        ).join('') + '</ul><button class="btn btn-sm btn-outline" data-list-add="' + key + '">＋ 항목 추가</button></div>';
      if (!isNew || sum.decisions.length) h += simpleList('결정 사항', 'decisions', sum.decisions);
      if (!isNew || sum.openIssues.length) h += simpleList('미결 안건', 'openIssues', sum.openIssues);
      /* 담당자별 할 일 — 신형은 실제로 있을 때만 (담당자 없으면 '미지정' 그룹) */
      if (!isNew || sum.todos.length) {
        h += '<div class="ai-block"><h3><span class="dot"></span>담당자별 할 일</h3>';
        const groups = VN.summarizer.groupTodosByOwner(sum.todos);
        if (groups.length) {
          h += groups.map(g =>
            '<div style="margin-bottom:8px"><div class="faint small" style="font-weight:600">' + U.esc(g.owner) + '</div><ul>' +
            g.items.map(t => {
              const i = t.index;
              return '<li><span class="ai-editable" contenteditable="true" data-todo="' + i + '">' + U.esc(t.task) + '</span> ' +
                '<span class="ai-editable faint small" contenteditable="true" data-todo-due="' + i + '">' + U.esc(t.due || '기한 없음') + '</span> ' +
                '<button class="icon-btn btn-sm" data-todo-del="' + i + '" style="padding:1px 6px">✕</button></li>';
            }).join('') + '</ul></div>').join('');
        }
        h += '<button class="btn btn-sm btn-outline" id="ai-todo-add">＋ 항목 추가</button></div>';
      }
      if (sum.topics.length) {
        h += '<div class="ai-block"><h3><span class="dot"></span>주요 주제</h3>' +
          sum.topics.map((t, i) =>
            '<div style="margin-bottom:8px"><span class="seg-time memo-time" data-topic-t="' + (t.start || 0) + '">' + U.fmtTime(t.start || 0) + '</span> ' +
            '<b class="ai-editable" contenteditable="true" data-topic-title="' + i + '" style="display:inline-block">' + U.esc(t.title) + '</b>' +
            '<div class="ai-editable muted" contenteditable="true" data-topic-sum="' + i + '">' + U.esc(t.summary) + '</div></div>'
          ).join('') + '</div>';
      }
      h += '<div class="ai-block"><h3><span class="dot"></span>키워드</h3><div id="ai-kws">' +
        (sum.keywords || []).map((k, i) => '<span class="kw-chip">#' + U.esc(k) + ' <a href="#" data-kw-del="' + i + '" style="text-decoration:none">✕</a></span>').join('') +
        '</div><div class="record-memo-row" style="margin-top:8px;max-width:260px"><input type="text" id="ai-kw-new" placeholder="키워드 추가">' +
        '<button class="btn btn-sm" id="ai-kw-add">추가</button></div></div>';
      el.innerHTML = h;

      /* 편집 저장 */
      $('#ai-summary').onblur = async () => { note.summary.summary = $('#ai-summary').textContent.trim(); await saveNote(note); };
      $$('[data-sec]', el).forEach(x => x.onblur = async () => {
        note.summary.sections[+x.dataset.sec].items[+x.dataset.sitem] = x.textContent.trim();
        await saveNote(note);
      });
      $$('[data-sec-del]', el).forEach(x => x.onclick = async () => {
        note.summary.sections[+x.dataset.secDel].items.splice(+x.dataset.sitem, 1);
        await saveNote(note); renderResult();
      });
      $$('[data-topic-title]', el).forEach(x => x.onblur = async () => { note.summary.topics[+x.dataset.topicTitle].title = x.textContent.trim(); await saveNote(note); });
      $$('[data-topic-sum]', el).forEach(x => x.onblur = async () => { note.summary.topics[+x.dataset.topicSum].summary = x.textContent.trim(); await saveNote(note); });
      $$('[data-topic-t]', el).forEach(x => x.onclick = () => { if (S.player) S.player.playFrom(+x.dataset.topicT); });
      $$('[data-list]', el).forEach(x => x.onblur = async () => {
        note.summary[x.dataset.list][+x.dataset.idx] = x.textContent.trim();
        await saveNote(note);
      });
      $$('[data-list-del]', el).forEach(x => x.onclick = async () => {
        note.summary[x.dataset.listDel].splice(+x.dataset.idx, 1);
        await saveNote(note); renderResult();
      });
      $$('[data-list-add]', el).forEach(x => x.onclick = async () => {
        const key = x.dataset.listAdd;
        note.summary[key].push(key === 'decisions' ? '새 결정 사항' : '새 미결 안건');
        await saveNote(note); renderResult();
      });
      $$('[data-todo]', el).forEach(x => x.onblur = async () => { note.summary.todos[+x.dataset.todo].task = x.textContent.trim(); await saveNote(note); });
      $$('[data-todo-due]', el).forEach(x => x.onblur = async () => {
        const v = x.textContent.trim();
        note.summary.todos[+x.dataset.todoDue].due = (v === '기한 없음') ? '' : v;
        await saveNote(note);
      });
      $$('[data-todo-del]', el).forEach(x => x.onclick = async () => { note.summary.todos.splice(+x.dataset.todoDel, 1); await saveNote(note); renderResult(); });
      if ($('#ai-todo-add')) $('#ai-todo-add').onclick = async () => { note.summary.todos.push({ owner: '', task: '새 할 일', due: '' }); await saveNote(note); renderResult(); };
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
      // 생성 중 스켈레톤 — 빈 화면 대신 자리 표시
      const resBox = $('#ai-result');
      if (resBox) resBox.innerHTML =
        '<div class="skel" style="height:96px;margin-bottom:10px"></div>' +
        '<div class="skel" style="height:72px;margin-bottom:10px"></div>' +
        '<div class="skel" style="height:72px"></div>';
      try {
        note.summary = await VN.summarizer.run(note, (n, total) => {
          const b = $('#btn-ai-run');
          if (b) b.textContent = '재시도 ' + n + '/' + total + '…';
        });
        await saveNote(note);
        renderResult();
        if (note.summary && note.summary.fallbackReason) {
          // 폴백이면 성공 토스트 대신 사유를 알린다
          toast(note.summary.fallbackReason + ' — 다시 시도해 보세요.', 5000);
        } else {
          toast('AI 정리를 생성했습니다.');
        }
      } catch (e) {
        toast('생성 실패: ' + (e.message || e));
        renderResult(); // 실패 시 스켈레톤 제거 후 기존 상태 복원
      }
      const b = $('#btn-ai-run');
      if (b) { b.disabled = false; b.textContent = 'AI 정리 다시 생성'; }
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
      '<div class="check-row hidden" id="ex-audio-row"><input type="checkbox" id="ex-audio"><label for="ex-audio">오디오 포함 (파일이 커집니다)</label></div>' +
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
    // 녹음이 진행 중인데 다시 진입("● 새 녹음" 재클릭 등)하면 세션을 리셋하지 않고
    // 기존 녹음 화면을 그대로 재표시한다 — 리셋하면 마이크가 켜진 채 UI만 초기화(고아 세션)된다.
    const resuming = !!(S.rec && S.rec.active && VN.recorder.state !== 'idle');
    const recSupported = VN.recorder.supported;
    const sttSupported = VN.stt.supported;
    // 모바일은 SpeechRecognition이 MediaRecorder와 마이크를 공유하지 못해(일부 기기는 녹음이 무음)
    // 실시간 자막을 끄고 녹음 종료 후 사후 전사를 안내한다.
    const mobile = isMobile();
    const MOBILE_NOTICE = '모바일에서는 실시간 자막이 지원되지 않습니다. 녹음을 마치면 자동으로 텍스트 변환이 시작됩니다.';
    // 녹음 화면 동안 하단 내비 숨김 (오탭 이탈 차단) — route()가 다른 화면 진입 시 제거
    document.body.classList.add('on-record');
    /* 상단 고정 앱바: ←(취소·확인 모달) + 제목 + 화면 켜짐 유지 토글(☀ 아이콘 버튼) */
    let html = '<div class="topbar"><div class="topbar-row">' +
      '<button class="icon-btn plain" id="rec-back" aria-label="녹음 취소·뒤로">←</button>' +
      '<h1 class="bar-title">녹음</h1><div class="spacer"></div>' +
      '<button class="icon-btn" id="rec-wakelock-btn" aria-pressed="false" aria-label="화면 켜짐 유지" title="화면 켜짐 유지">☀</button>' +
      '</div></div>';
    html += '<div class="view under-1 record-wrap">';
    if (!recSupported) {
      html += '<div class="banner">이 브라우저는 녹음(MediaRecorder)을 지원하지 않습니다. Chrome 또는 Edge를 사용해 주세요.</div>';
    }
    if (!sttSupported && !mobile) {
      html += '<div class="banner">이 브라우저는 음성인식(SpeechRecognition)을 지원하지 않아 자막 없이 녹음만 진행됩니다. (Chrome/Edge 권장)</div>';
    }
    /* 언어는 상태 줄 옆 텍스트 버튼(menuPop) — 숨은 select가 값의 원본 */
    html += '<div id="rec-cal"></div>' +
      '<select id="rec-lang" aria-label="인식 언어" hidden>' +
      '<option value="ko-KR">한국어</option><option value="en-US">영어 (미국)</option>' +
      '<option value="ja-JP">일본어</option><option value="zh-CN">중국어 (간체)</option></select>' +
      '<div class="record-timer" id="rec-timer">00:00</div>' +
      '<div class="record-state-row"><span id="rec-state">녹음 대기 중</span>' +
      '<button class="rec-lang-btn" id="rec-lang-btn" aria-label="인식 언어 선택">한국어 ▾</button></div>' +
      '<canvas id="record-wave" width="640" height="90"></canvas>' +
      (mobile ? '' : '<div class="speaker-tabs" id="rec-speakers"></div>') +
      '<div id="rec-warn"></div>' +
      (mobile
        ? '<div class="banner info" style="margin-top:12px">' + MOBILE_NOTICE + '</div>'
        : '<div class="stt-live" id="stt-live"><span class="faint">녹음을 시작하면 실시간 자막이 여기에 표시됩니다.</span></div>') +
      '<div class="record-memo-row"' + (mobile ? ' style="margin-top:4px"' : '') + '>' +
      '<button class="icon-btn" id="rec-bookmark" aria-label="현재 시점 북마크" disabled>🔖</button>' +
      '<input type="text" id="rec-memo" placeholder="📝 타임스탬프 메모 입력 후 Enter" aria-label="타임스탬프 메모" disabled>' +
      '</div>' +
      '<div class="record-controls" id="rec-controls">' +
      '<button class="btn btn-primary btn-rec-start" id="rec-start"' + (recSupported ? '' : ' disabled') + '>● 녹음 시작</button>' +
      '</div></div>';
    main().innerHTML = html;

    /* 언어 버튼 ↔ 숨은 select 동기화 */
    const syncLangBtn = () => {
      const sel = $('#rec-lang'), b = $('#rec-lang-btn');
      if (!sel || !b) return;
      b.textContent = (LANG_LABEL[sel.value] || sel.value) + ' ▾';
      b.disabled = sel.disabled;
    };
    $('#rec-lang-btn').onclick = (e) => {
      const sel = $('#rec-lang');
      if (!sel || sel.disabled) return;
      menuPop(e.currentTarget, ['ko-KR', 'en-US', 'ja-JP', 'zh-CN'].map(v => ({
        label: LANG_LABEL[v] || v, checked: sel.value === v,
        onClick: () => { sel.value = v; syncLangBtn(); }
      })));
    };

    /* ← : 녹음 중이면 확인 모달 후 취소, 아니면 목록으로 */
    $('#rec-back').onclick = async () => {
      if (S.rec && S.rec.active) {
        if (await confirmModal('녹음 취소', '지금까지 녹음한 내용이 모두 사라집니다.<br>저장하려면 ■ 종료 버튼을 누르세요.', '녹음 취소', true)) {
          VN.stt.stop();
          VN.recorder.cancel();
          clearInterval(S.rec.timerId);
          S.rec.active = false;
          releaseWakeLock();
          document.title = '보이스노트';
          updateNav();
          go('#/list');
        }
      } else go('#/list');
    };

    if (!resuming) VN.db.getSetting('defaultLang', 'ko-KR').then(l => {
      const sel = $('#rec-lang');
      if (sel) { sel.value = l; syncLangBtn(); }
    });
    syncLangBtn();

    // Wake Lock 옵션 — ☀ 아이콘 토글 (미지원 브라우저는 숨김)
    if (!('wakeLock' in navigator)) {
      $('#rec-wakelock-btn').classList.add('hidden');
    } else {
      const wlBtn = $('#rec-wakelock-btn');
      const setWl = (on) => { wlBtn.classList.toggle('on', on); wlBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); };
      VN.db.getSetting('wakeLock', false).then(v => { if (wlBtn.isConnected) setWl(!!v); });
      wlBtn.onclick = () => {
        const on = !wlBtn.classList.contains('on');
        setWl(on);
        VN.db.setSetting('wakeLock', on);
        if (S.rec && S.rec.active) { if (on) acquireWakeLock(); else releaseWakeLock(); }
      };
    }

    if (!resuming) {
      S.rec = {
        active: false, lang: 'ko-KR',
        segments: [], memos: [], bookmarks: [],
        speakers: [{ name: '참석A' }, { name: '참석B' }, { name: '참석C' }],
        curSpeaker: 0, timerId: null, sttWarned: false, sttOn: false
      };
    }

    const renderSpeakers = () => {
      const el = $('#rec-speakers');
      if (!el) return;
      el.innerHTML = S.rec.speakers.map((sp, i) =>
        '<button class="speaker-tab' + (i === S.rec.curSpeaker ? ' active' : '') + '" data-sp="' + i + '">' + U.esc(sp.name) + '</button>'
      ).join('') + (S.rec.speakers.length < 8 ? '<button class="speaker-tab" data-sp="add">＋</button>' : '');
      $$('.speaker-tab', el).forEach(b => b.onclick = () => {
        if (b.dataset.sp === 'add') {
          S.rec.speakers.push({ name: U.speakerDefaultName(S.rec.speakers.length) });
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

    // live는 항상 현재 DOM에서 찾는다 — 녹음 중 화면이 재렌더돼도(재진입) 이전에 등록된
    // STT 콜백이 떨어져 나간 옛 노드가 아니라 새 자막 영역에 계속 출력되게 하기 위함.
    const live = () => $('#stt-live');
    let interimEl = null;

    const renderFinalDom = (seg) => {
      const box = live();
      if (!box) return;
      const div = document.createElement('div');
      div.className = 'segment';
      div.innerHTML = '<div class="seg-avatar" style="background:' + speakerColor(seg.speaker) + '">' +
        U.esc(U.speakerInitial(S.rec.speakers[seg.speaker].name)) + '</div>' +
        '<div class="seg-body"><div class="seg-head"><span>' + U.esc(S.rec.speakers[seg.speaker].name) + '</span>' +
        '<span>' + U.fmtTime(seg.start) + '</span></div>' +
        '<div class="seg-text">' + U.esc(seg.text) + '</div></div>';
      if (interimEl && interimEl.isConnected) box.insertBefore(div, interimEl);
      else box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    };
    const appendFinal = (seg) => {
      S.rec.segments.push(seg);
      renderFinalDom(seg);
    };
    const showInterim = (text) => {
      const box = live();
      if (!box) return;
      if (!interimEl || !interimEl.isConnected) {
        interimEl = document.createElement('div');
        interimEl.className = 'interim';
        box.appendChild(interimEl);
      }
      interimEl.textContent = text || '';
      box.scrollTop = box.scrollHeight;
    };

    const startTimer = () => {
      // UI 갱신 전용 — 경과시간 데이터는 VN.recorder.currentTime()(Date.now 기반)이 진실.
      S.rec.timerId = setInterval(() => {
        const cur = U.fmtTime(VN.recorder.currentTime());
        const t = $('#rec-timer');
        if (t) t.textContent = cur;
        // 탭 숨김 중에도 1분 간격으로는 동작 → 제목으로 진행 상황 표시
        if (S.rec && S.rec.active) document.title = '● ' + cur + ' 녹음 중 — 보이스노트';
        // STT 감시(데스크톱): 인식을 시작했는데 15초간 결과가 없으면 1회 비차단 안내
        if (S.rec && S.rec.active && S.rec.sttOn && !S.rec.sttWarned &&
            VN.recorder.state === 'recording' && Date.now() - VN.stt.lastResultAt() > 15000) {
          S.rec.sttWarned = true;
          const warn = $('#rec-warn');
          if (warn) warn.innerHTML = '<div class="banner">15초 이상 음성인식 결과가 없습니다. 녹음은 계속 저장되고 있으며, 종료 후 자동으로 텍스트 변환이 시작됩니다.</div>';
        }
      }, 250);
    };

    const setControls = (mode) => {
      const c = $('#rec-controls');
      if (mode === 'recording') {
        c.innerHTML = '<button class="rec-round" id="rec-pause" aria-label="일시정지">⏸</button>' +
          '<button class="rec-round primary" id="rec-stop" aria-label="종료하고 저장">■</button>' +
          '<button class="rec-round" id="rec-memo-focus" aria-label="메모 입력으로 이동">📝</button>';
        $('#rec-pause').onclick = () => {
          VN.recorder.pause();
          VN.stt.pause();
          $('#rec-state').innerHTML = '일시정지됨 <span class="faint">(일시정지 구간은 타임스탬프에서 제외)</span>';
          setControls('paused');
        };
      } else if (mode === 'paused') {
        c.innerHTML = '<button class="rec-round" id="rec-resume" aria-label="재개">▶</button>' +
          '<button class="rec-round primary" id="rec-stop" aria-label="종료하고 저장">■</button>' +
          '<button class="rec-round" id="rec-memo-focus" aria-label="메모 입력으로 이동">📝</button>';
        $('#rec-resume').onclick = () => {
          VN.recorder.resume();
          if (S.rec.sttOn) VN.stt.resume(S.rec.lang);
          $('#rec-state').innerHTML = '<span class="rec-dot"></span>녹음 중';
          setControls('recording');
        };
      }
      if ($('#rec-stop')) $('#rec-stop').onclick = () => finishRecording(false);
      if ($('#rec-memo-focus')) $('#rec-memo-focus').onclick = () => { const i = $('#rec-memo'); if (i) i.focus(); };
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
      updateNav();
      const wlBtn2 = $('#rec-wakelock-btn');
      if (wlBtn2 && wlBtn2.classList.contains('on')) acquireWakeLock();
      const liveBox = live();
      if (liveBox) liveBox.innerHTML = '';
      interimEl = null;
      $('#rec-lang').disabled = true;
      syncLangBtn();
      $('#rec-bookmark').disabled = false;
      $('#rec-memo').disabled = false;
      $('#rec-state').innerHTML = '<span class="rec-dot"></span>녹음 중';
      setControls('recording');
      startTimer();
      // 모바일은 마이크 경합(일부 기기는 녹음 쪽이 무음)을 피하기 위해 STT를 아예 시작하지 않는다
      if (VN.stt.supported && !mobile) {
        S.rec.sttOn = true;
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

    /* 진행 중 세션 재표시 — 데이터·마이크·타이머는 그대로 두고 UI만 복원한다.
       (기존 timerId interval과 STT 콜백은 DOM을 매번 새로 찾으므로 계속 동작) */
    if (resuming) {
      const langSel = $('#rec-lang');
      if (langSel) { langSel.value = S.rec.lang; langSel.disabled = true; }
      syncLangBtn();
      $('#rec-bookmark').disabled = false;
      $('#rec-memo').disabled = false;
      const box = live();
      if (box) box.innerHTML = '';
      interimEl = null;
      for (const seg of S.rec.segments) renderFinalDom(seg);
      const paused = VN.recorder.state === 'paused';
      $('#rec-state').innerHTML = paused
        ? '일시정지됨 <span class="faint">(일시정지 구간은 타임스탬프에서 제외)</span>'
        : '<span class="rec-dot"></span>녹음 중';
      setControls(paused ? 'paused' : 'recording');
      const t = $('#rec-timer');
      if (t) t.textContent = U.fmtTime(VN.recorder.currentTime());
      VN.recorder.bindCanvas($('#record-wave'));
    }
  }

  /* 녹음 종료 → 노트 생성 (silent=true면 화면 전환 없이 저장만). 성공 시 true 반환 */
  async function finishRecording(silent) {
    if (!S.rec || !S.rec.active) return false;
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
      return false;
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
    invalidateNotesCache();
    // 노트가 안전하게 저장됐으니 크래시 세이프 청크 정리
    try { await VN.db.clear('recChunks'); } catch (e) { /* ignore */ }
    S.rec = null;
    updateNav();
    // 녹음 중 보류해 둔 배포 감지 배너가 있으면 이제 표시
    if (deployPendingWhileRec) { deployPendingWhileRec = false; showDeployBanner(); }
    // 전사 세그먼트가 없고 오디오가 충분히 길면(≈3초+) 묻지 않고 자동 텍스트 변환 시작
    // (모바일은 실시간 자막이 없어 항상 이 경로를 탄다)
    let transcribing = { started: false };
    if (!note.segments.length && note.audioBlob instanceof Blob && (note.duration || 0) >= 3) {
      transcribing = await VN.transcribe.start(note);
    }
    if (!silent) {
      // 토스트 없이 노트 상세로 전환 — 화면 이동 자체가 저장 피드백, 진행 상태는 인라인 배너로
      go('#/note/' + note.id);
    }
    // Drive 자동 저장: 변환을 시작했으면 완료·실패 후 1회(transcribe 리스너에서 실행 —
    // 전사 없는 상태로 먼저 올라가 두 번 덮어쓰는 낭비 제거), 변환이 없으면 지금 백그라운드로.
    if (!transcribing.started) driveAutoSaveAfter(note);
    return true;
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

  const IMPORT_FOLDER_NAME = '가져온 음원';

  /* 파일로 만든 노트를 담는 "가져온 음원" 폴더 — 없으면 자동 생성 */
  async function ensureImportFolder() {
    const folders = await VN.db.getFolders();
    const found = folders.find(f => f.name === IMPORT_FOLDER_NAME);
    if (found) return found;
    return VN.db.saveFolder({ name: IMPORT_FOLDER_NAME });
  }

  async function importFiles(files) {
    const audioFiles = [...files].filter(f => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/'));
    if (!audioFiles.length) { toast('지원하는 오디오 파일이 아닙니다. (mp3/m4a/aac/wav/webm/ogg)'); return; }
    let importFolder = null;
    try { importFolder = await ensureImportFolder(); } catch (e) { /* 폴더 실패해도 가져오기는 진행 */ }
    const notes = [];
    for (const f of audioFiles) {
      toast('"' + f.name + '" 분석 중…');
      const info = await analyzeAudio(f);
      const note = VN.db.newNote({
        title: f.name.replace(/\.[^.]+$/, ''),
        duration: info.duration,
        audioBlob: f,
        audioType: f.type || '',
        sourceType: 'upload',
        folderId: importFolder ? importFolder.id : null,
        tags: [fileTag(f.name)],
        waveform: info.waveform,
        language: await VN.db.getSetting('defaultLang', 'ko-KR')
      });
      await VN.db.saveNote(note);
      notes.push(note);
    }
    // 선택 모달 없이 자동으로 텍스트 변환 시작 (키가 없으면 노트에 안내가 남는다)
    for (const n of notes) await VN.transcribe.start(n);
    invalidateNotesCache();
    await refresh(true);
    if (notes.length === 1) {
      go('#/note/' + notes[0].id);
    } else {
      toast(notes.length + '개 파일을 불러왔습니다.');
      route();
    }
  }

  /* ── 노트 상세 ⋯ → 다시 변환: 엔진 선택 (자동/Deepgram/AssemblyAI/Gemini/Whisper/수동) ── */
  function retranscribeMenu(note) {
    if (!(note.audioBlob instanceof Blob)) { toast('오디오가 없는 노트입니다.'); return; }
    if (VN.transcribe.isActive(note.id)) { toast('이미 텍스트 변환이 진행 중입니다.'); return; }
    const m = modal('<h2>🎤 다시 변환</h2><div class="modal-body">' +
      '<p class="muted small" style="margin-bottom:10px">오디오 전체를 다시 텍스트로 변환합니다.' +
      ((note.segments || []).length ? ' 기존 세그먼트 ' + note.segments.length + '개와 참석자 이름이 <b>대체</b>됩니다.' : '') + '</p>' +
      [['auto', '⚡ 자동 (권장 — 저장된 키 순서대로)'],
       ['deepgram', 'Deepgram (자동 화자분리)'],
       ['assemblyai', 'AssemblyAI (자동 화자분리)'],
       ['gemini', 'Gemini'],
       ['whisper', 'Whisper — 인터넷 없이 이 기기에서 처리 (느림)'],
       ['manual', '✎ 수동 입력 (구간 직접 추가)']].map(o =>
        '<button class="btn btn-block" style="margin-bottom:8px;justify-content:flex-start" data-eng="' + o[0] + '">' + o[1] + '</button>').join('') +
      '</div><div class="modal-actions"><button class="btn" data-x="no">취소</button></div>');
    $('[data-x="no"]', m).onclick = () => m.remove();
    $$('[data-eng]', m).forEach(b => b.onclick = () => { m.remove(); runRetranscribe(note, b.dataset.eng); });
  }

  async function runRetranscribe(note, engine) {
    if (engine === 'manual') {
      // 수동: 음성 기록 탭으로 이동해 빈 구간을 추가하고 바로 편집 시작
      S.noteTab = 'seg';
      $$('.tab').forEach(x => {
        const on = x.dataset.tab === 'seg';
        x.classList.toggle('active', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderTabBody(note);
      const b = $('#btn-add-seg');
      if (b) b.click();
      return;
    }
    if (engine === 'auto') {
      const r = await VN.transcribe.start(note);
      if (!r.started && r.reason === 'no-keys') {
        try { sessionStorage.setItem('advFocus', 'gemini'); } catch (e) { }
        go('#/settings/advanced');
      } else if (r.started) {
        setNotePipe(note.id, '⏳ 자동 텍스트 변환 중 — 화면을 이동해도 계속됩니다.');
        renderTabBody(note);
      }
      return;
    }
    // 개별 엔진 — 진행 표시와 함께 직접 실행
    const m = modal('<h2>다시 변환 중…</h2><div class="modal-body">' +
      '<div id="rt-msg" class="muted small">변환을 시작합니다…</div>' +
      '<div class="progress-outer"><div class="progress-inner" id="rt-bar"></div></div></div>');
    const setP = (pct, msg) => {
      const bar = $('#rt-bar', m);
      if (bar && isFinite(pct)) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      const t = $('#rt-msg', m);
      if (t && msg) t.textContent = msg;
    };
    try {
      if (engine === 'whisper') {
        const segs = await VN.whisper.transcribe(note.audioBlob, { model: 'tiny', language: note.language, onProgress: setP });
        if (!segs.length) throw new Error('인식된 음성이 없습니다.');
        note.speakers = [{ name: U.speakerDefaultName(0) }];
        note.segments = segs.map(sg => ({
          id: U.uid(), speaker: 0, start: sg.start, end: sg.end, text: sg.text,
          bookmarked: false, highlighted: false
        }));
      } else if (engine === 'gemini') {
        setP(30, 'Gemini로 변환 중…');
        const items = await VN.summarizer.transcribeAudioGemini(note.audioBlob, { language: note.language });
        if (!items.length) throw new Error('인식된 음성이 없습니다.');
        VN.transcribe._test.applyGeminiSegments(note, items);
      } else {
        setP(30, (engine === 'deepgram' ? 'Deepgram' : 'AssemblyAI') + '으로 변환 중…');
        const r = await VN.diarize.transcribe(note.audioBlob, { provider: engine, language: note.language, onProgress: setP });
        if (!r.segments.length) throw new Error('인식된 음성이 없습니다.');
        VN.transcribe._test.applyDiarizeSegments(note, r);
      }
      note.transcribePending = false;
      note.transcribeError = null;
      await saveNote(note);
      m.remove();
      toast('텍스트 변환 완료 (' + note.segments.length + '개 구간)');
      if (S.note && S.note.id === note.id) viewNote(note.id);
    } catch (e) {
      m.remove();
      toast('변환 실패: ' + ((e && e.message) || e), 5000);
    }
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

  /* ── 전사 완료 직후 AI 정리 자동 생성 (설정 autoSummarize, 기본 ON) ──
     백그라운드로 실행되며 실패해도 전사 결과는 그대로 보존된다(토스트로만 알림).
     키가 없으면 summarizer.run이 로컬(기본) 모드로 요약한다. */
  async function autoSummarizeAfter(noteId) {
    try {
      const on = await VN.db.getSetting('autoSummarize', true);
      if (!on) return;
      const note = await VN.db.getNote(noteId);
      if (!note || !(note.segments || []).some(s => s.text && s.text.trim())) return;
      setNotePipe(noteId, '🤖 AI 정리 생성 중…');
      const sum = await VN.summarizer.run(note);
      // 요약 생성 동안 제목·메모가 편집됐을 수 있으니 최신 노트에 반영한다
      const fresh = (await VN.db.getNote(noteId).catch(() => null)) || note;
      fresh.summary = sum;
      await VN.db.saveNote(fresh);
      invalidateNotesCache();
      // 같은 노트를 보고 있으면 인라인 갱신, 노트 밖에서는 토스트 없이 조용히 (완료 토스트는 변환 단계 1개만)
      if (S.note && S.note.id === noteId && (location.hash || '').startsWith('#/note/')) {
        if (isEditingDom()) toast('처리가 끝났습니다. 편집을 마치면 새로 고쳐집니다.');
        else await viewNote(noteId);
        if (sum.fallbackReason) setNotePipe(noteId, '⚠️ AI 정리는 기본 모드로 생성됨 — ' + U.esc(sum.fallbackReason));
      }
    } catch (e) {
      toast('AI 정리 자동 생성 실패: ' + ((e && e.message) || e) + ' — 노트의 AI 요약 탭에서 수동으로 생성할 수 있습니다.', 5000);
    }
  }

  /* ── 노트 생성·변환 직후 Drive 자동 저장 (await 없이 백그라운드로 호출됨) ── */
  async function driveAutoSaveAfter(note) {
    try {
      const r = await VN.drive.autoSave(note);
      // 저장 중 제목·파일명·링크가 갱신됐으면 지금 열려 있는 같은 노트 화면에 반영
      if (r && r.titleChanged && S.note && S.note.id === note.id) {
        S.note.title = note.title;
        S.note.driveFilename = note.driveFilename;
        if (note.driveLink) S.note.driveLink = note.driveLink;
        const ti = $('#note-title');
        if (ti) ti.value = note.title;
      }
      if (r && r.saved) {
        // 노트를 보고 있으면 인라인 배너로만, 노트 밖에서는 토스트 없이 조용히
        if (setNotePipe(note.id, '☁ Drive 저장됨 ✓ ' + U.esc(r.filename || ''))) {
          setTimeout(() => setNotePipe(note.id, ''), 4000);
        }
      } else {
        setNotePipe(note.id, '');
        if (r && !r.skipped && r.message) toast(r.message);
      }
      if (r && r.authExpired) notifyAuthExpired();
      return r;
    } catch (e) { toast('Drive 자동 저장 실패: ' + (e.message || e)); }
  }

  /* ══════════════ 휴지통 ══════════════ */

  async function viewTrash() {
    const items = await VN.db.getTrash();
    let html = '<div class="topbar"><div class="topbar-row">' +
      '<button class="icon-btn plain" id="tr-back" aria-label="뒤로">←</button>' +
      '<h1 class="bar-title">휴지통</h1><div class="spacer"></div>' +
      (items.length ? '<button class="btn btn-danger btn-sm" id="btn-trash-empty">비우기</button>' : '') +
      '</div></div>' +
      '<div class="view under-1">' +
      '<p class="muted small" style="margin-bottom:14px">삭제된 노트는 30일간 보관 후 자동으로 영구 삭제됩니다.</p>' +
      '<div id="trash-list"></div></div>';
    main().innerHTML = html;
    $('#tr-back').onclick = () => go('#/list');
    const list = $('#trash-list');
    if (!items.length) {
      list.innerHTML = '<div class="empty-state"><div class="big">🗑️</div>휴지통이 비어 있습니다.</div>';
      return;
    }
    list.innerHTML = items.map(n => {
      const daysLeft = Math.max(0, Math.ceil((VN.db.TRASH_KEEP_MS - (Date.now() - n.deletedAt)) / 86400000));
      return '<div class="trash-item"><div><div class="t-title">' + U.esc(n.title) + '</div>' +
        '<div class="t-meta">⏱ ' + U.fmtTime(n.duration || 0) + ' · 삭제: ' + U.fmtDate(n.deletedAt) + ' · ' + daysLeft + '일 후 영구 삭제</div></div>' +
        '<div class="t-actions"><button class="btn btn-sm" data-restore="' + n.id + '">복원</button>' +
        '<button class="btn btn-sm btn-danger" data-purge="' + n.id + '">영구 삭제</button></div></div>';
    }).join('');
    $$('[data-restore]', list).forEach(b => b.onclick = async () => {
      await VN.db.restoreNote(b.dataset.restore);
      invalidateNotesCache();
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

  /* ══════════════ 설정 (2계층: 메인 = 일상 / 고급 = 기술) ══════════════ */

  const TARGET_LABEL = { folder: 'PC 폴더', api: 'Drive API', webhook: 'Apps Script 웹훅', none: '사용 안 함' };

  /* ── 설정 메인 (#/settings) — 일상 설정만. 기술 항목은 고급 설정으로 분리 ── */
  async function viewSettings() {
    // 일상 설정 5개 + 연동 상태 뱃지용 로컬 값만 읽는다 (네트워크·권한 조회는 고급 화면에서만)
    const [lang, theme, autoSum, driveAuto, personaCtx, apiKey, dgKey, aaiKey, driveTarget, gStatus] = await Promise.all([
      VN.db.getSetting('defaultLang', 'ko-KR'),
      VN.db.getSetting('theme', 'system'),
      VN.db.getSetting('autoSummarize', true),
      VN.db.getSetting('driveAutoSave', true),
      VN.db.getSetting('personaContext', ''),
      VN.db.getSetting('geminiApiKey', ''),
      VN.db.getSetting('deepgramApiKey', ''),
      VN.db.getSetting('assemblyaiApiKey', ''),
      VN.drive.getTarget(),
      VN.gauth.status()
    ]);
    // 사용 통계
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthNotes = S.notes.filter(n => n.createdAt >= monthStart);
    const monthSec = monthNotes.reduce((a, n) => a + (n.duration || 0), 0);
    const totalSec = S.notes.reduce((a, n) => a + (n.duration || 0), 0);

    let html = '<div class="topbar"><div class="topbar-row">' +
      '<button class="icon-btn plain" id="st-back" aria-label="뒤로">←</button>' +
      '<h1 class="bar-title">설정</h1></div></div>' +
      '<div class="view under-1">';

    html += '<div class="settings-group"><h2>이번 달 사용량 <span class="faint small">(제한 없음)</span></h2>' +
      '<div class="stat-cards">' +
      '<div class="stat-card"><div class="val">' + U.fmtTime(monthSec) + '</div><div class="lbl">이번 달 녹음 시간</div></div>' +
      '<div class="stat-card"><div class="val">' + U.fmtTime(totalSec) + '</div><div class="lbl">누적 녹음 시간</div></div>' +
      '<div class="stat-card"><div class="val">' + S.notes.length + '</div><div class="lbl">전체 노트 수</div></div>' +
      '</div><div class="muted small" style="margin-top:8px" id="st-storage"></div></div>';

    html += '<div class="settings-group"><h2>기본</h2>' +
      '<div class="settings-row"><label>테마</label><select id="st-theme">' +
      '<option value="system">시스템 설정 따름</option><option value="light">라이트</option><option value="dark">다크</option></select></div>' +
      '<div class="settings-row"><label>기본 인식 언어</label><select id="st-lang">' +
      '<option value="ko-KR">한국어</option><option value="en-US">영어 (미국)</option>' +
      '<option value="ja-JP">일본어</option><option value="zh-CN">중국어 (간체)</option></select></div>' +
      '<div class="settings-row"><label>자동 AI 정리</label>' +
      '<span class="check-row" style="margin:0"><input type="checkbox" id="st-autosum"' + (autoSum ? ' checked' : '') + '>' +
      '<label for="st-autosum" class="small">변환 완료 후 AI 정리 자동 실행</label></span></div>' +
      '<div class="settings-row"><label>Drive 자동 저장</label>' +
      '<span class="check-row" style="margin:0"><input type="checkbox" id="dr-auto"' + (driveAuto ? ' checked' : '') + '>' +
      '<label for="dr-auto" class="small">녹음·변환 직후 자동 저장</label></span></div>' +
      '<p class="muted small">저장 경로: ' + (TARGET_LABEL[driveTarget] || driveTarget) + ' — 경로·형식 변경은 고급 설정에서.</p></div>';

    html += '<div class="settings-group"><h2>AI 개인화</h2>' +
      '<div class="settings-row" style="align-items:flex-start"><label>나에 대한 설명</label>' +
      '<textarea id="st-persona" rows="5" style="flex:1;min-width:200px;resize:vertical" ' +
      'placeholder="나에 대한 설명을 자유롭게 적어 주세요 (직업, 주 용도, 자주 등장하는 주제, 원하는 요약 스타일 등)">' +
      U.esc(personaCtx) + '</textarea></div>' +
      '<div class="settings-row"><label></label>' +
      '<button class="btn btn-sm btn-primary" id="st-persona-save">저장</button>' +
      '<button class="btn btn-sm" id="st-persona-example">예시 넣기</button>' +
      (personaCtx ? '<button class="btn btn-sm" id="st-persona-del">삭제</button>' : '') + '</div>' +
      '<p class="muted small">AI가 요약·분석할 때 항상 참고하는 나에 대한 설명입니다. ' +
      'AI 요약(유형 분류·섹션·마인드맵), 오디오 전사(전문 용어 인식), Drive 파일명 주제 생성에 반영됩니다. 이 기기의 브라우저에만 저장됩니다.</p></div>';

    /* 연동 상태 요약 카드 — 상세 설정은 [관리]로 고급 설정에 진입 */
    const connBadge = (ok, offLabel) => ok
      ? '<span class="conn-badge">연동됨 ✅</span>'
      : '<span class="conn-badge off">' + (offLabel || '미설정') + '</span>';
    html += '<div class="settings-group"><h2>연동 상태</h2>' +
      '<div class="conn-row"><span class="conn-name">AI 요약</span>' + connBadge(!!apiKey) +
      '<button class="btn btn-sm btn-outline" data-adv="gemini">관리</button></div>' +
      '<div class="conn-row"><span class="conn-name">화자분리</span>' + connBadge(!!(dgKey || aaiKey)) +
      '<button class="btn btn-sm btn-outline" data-adv="diarize">관리</button></div>' +
      '<div class="conn-row"><span class="conn-name">Google 계정</span>' +
      connBadge(gStatus.signedIn, gStatus.configured ? '로그인 안 됨' : '미설정') +
      '<button class="btn btn-sm btn-outline" data-adv="google">관리</button></div>' +
      '<div class="conn-row"><span class="conn-name">저장 경로</span>' +
      (driveTarget !== 'none'
        ? '<span class="conn-badge">' + U.esc(TARGET_LABEL[driveTarget] || driveTarget) + '</span>'
        : '<span class="conn-badge off">미설정</span>') +
      '<button class="btn btn-sm btn-outline" data-adv="drive">관리</button></div></div>';

    html += '<div class="settings-group"><h2>데이터</h2>' +
      '<div class="settings-row"><label>전체 백업</label>' +
      '<span class="check-row" style="margin:0"><input type="checkbox" id="st-bk-audio" checked><label for="st-bk-audio" class="small">오디오 포함 (파일이 커집니다)</label></span>' +
      '<button class="btn btn-sm" id="st-backup">백업 파일 다운로드</button></div>' +
      '<div class="settings-row"><label>복원 (가져오기)</label><button class="btn btn-sm" id="st-restore">백업 파일 선택</button></div>' +
      '<div class="settings-row"><label>휴지통</label><button class="btn btn-sm" id="st-trash">휴지통 열기</button></div>' +
      '<div class="settings-row"><label>전체 삭제</label><button class="btn btn-sm btn-danger" id="st-wipe">모든 데이터 삭제</button></div>' +
      '<p class="muted small">클라우드 동기화 대신 백업 파일로 다른 기기에 옮길 수 있습니다.</p></div>';

    html += '<div class="settings-group">' +
      '<button class="link-row" id="st-adv">⚙️ 고급 설정 <span class="muted small">AI 키 · Google 계정 · Drive 상세</span><span class="lr-arrow">›</span></button></div>';

    html += '<div class="settings-group"><h2>도움말</h2><div class="muted small" style="line-height:1.8">' +
      '· 마이크 녹음과 실시간 음성인식은 Chrome/Edge + localhost(또는 HTTPS)에서만 동작합니다.<br>' +
      '· 실시간 음성인식(SpeechRecognition)은 브라우저가 제공하는 온라인 서비스라 인터넷 연결이 필요합니다.<br>' +
      '· Firefox는 음성인식을 지원하지 않아 녹음만 가능합니다. 녹음을 마치면 자동 텍스트 변환이 시작됩니다.<br>' +
      '· 모든 데이터는 이 기기의 브라우저에만 저장됩니다. 기기를 바꾸거나 브라우저 데이터를 지우면 사라지니 주기적으로 백업해 주세요.</div></div>';

    html += '</div>';
    main().innerHTML = html;

    /* 저장 후 재렌더 — 스크롤 위치 유지, 설정 메인이 열려 있을 때만 */
    const rerender = () => {
      if (location.hash.startsWith('#/settings') && !location.hash.includes('advanced')) {
        const y = window.scrollY;
        viewSettings().then(() => window.scrollTo(0, y));
      }
    };

    $('#st-back').onclick = () => go('#/list');
    $('#st-adv').onclick = () => go('#/settings/advanced');
    $$('[data-adv]').forEach(b => b.onclick = () => {
      try { sessionStorage.setItem('advFocus', b.dataset.adv); } catch (e) { }
      go('#/settings/advanced');
    });

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
    $('#st-autosum').onchange = (e) => VN.db.setSetting('autoSummarize', e.target.checked);
    $('#dr-auto').onchange = (e) => VN.db.setSetting('driveAutoSave', e.target.checked);
    VN.db.setSetting('apiKey', ''); // 이전 버전의 API 키 설정값 정리

    /* AI 개인화 컨텍스트 — 기본은 빈 값, 저장은 사용자가 직접(자동 강제 주입 없음) */
    const PERSONA_EXAMPLE = '나는 장례지도사이자 상담심리학을 공부하는 전문가다. ' +
      '장거리 이동 중 길고 두서없이 떠오르는 생각을 음성으로 기록하는 경우가 많다. ' +
      '고인을 가족처럼 대하는 마음, 유가족들의 얽힌 심리적 구조, 누군가를 깊이 배려하기 위한 복잡한 절차들이 기록에 자주 등장한다. ' +
      '요약은 전문 상담 일지나 서비스 기획 노트처럼 논리적이고 정돈된 형태로 작성해 달라.';
    $('#st-persona-save').onclick = async () => {
      await VN.db.setSetting('personaContext', $('#st-persona').value.trim());
      toast('AI 개인화 컨텍스트를 저장했습니다.');
      rerender();
    };
    $('#st-persona-example').onclick = () => {
      $('#st-persona').value = PERSONA_EXAMPLE;
      toast('예시를 채웠습니다. 내용을 다듬은 뒤 "저장"을 눌러 주세요.');
    };
    if ($('#st-persona-del')) $('#st-persona-del').onclick = async () => {
      await VN.db.setSetting('personaContext', '');
      toast('AI 개인화 컨텍스트를 삭제했습니다.');
      rerender();
    };

    /* 데이터 관리 */
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
    $('#st-trash').onclick = () => go('#/trash');
    $('#st-wipe').onclick = async () => {
      // 2단계 확인
      if (!await confirmModal('전체 삭제', '노트·폴더·휴지통·설정이 모두 삭제됩니다.', '계속', true)) return;
      const word = await promptModal('정말 삭제할까요?', '"삭제"라고 입력하면 진행합니다', '');
      if (word !== '삭제') { toast('입력이 일치하지 않아 취소했습니다.'); return; }
      await VN.db.wipeAll();
      invalidateNotesCache();
      toast('모든 데이터를 삭제했습니다.');
      go('#/list');
    };
  }

  /* ── 고급 설정 (#/settings/advanced) — 기술 항목을 아코디언으로 ── */
  async function viewSettingsAdvanced() {
    const [apiKey, driveFormat, driveAudio, hookUrl, hookToken, driveLast, folderStatus,
      clientId, gStatus, apiStatus, driveTarget, dgKey, aaiKey, geminiModel, geminiQuality] = await Promise.all([
      VN.db.getSetting('geminiApiKey', ''),
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
      VN.db.getSetting('assemblyaiApiKey', ''),
      VN.db.getSetting('geminiModel', VN.summarizer.DEFAULT_MODEL),
      VN.db.getSetting('geminiQuality', VN.summarizer.DEFAULT_QUALITY)
    ]);

    /* open 규칙: 미설정 그룹은 펼침, 설정 완료 그룹은 접힘 */
    const openMap = {
      gemini: !apiKey,
      diarize: !(dgKey || aaiKey),
      google: !gStatus.signedIn,
      drive: driveTarget === 'none',
      tools: false
    };
    const group = (key, title, state, body) =>
      '<details class="settings-group" id="adv-' + key + '"' + (openMap[key] ? ' open' : '') + '>' +
      '<summary>' + title + (state ? '<span class="group-state">' + state + '</span>' : '') + '</summary>' +
      '<div class="group-body">' + body + '</div></details>';

    let html = '<div class="topbar"><div class="topbar-row">' +
      '<button class="icon-btn plain" id="st-back" aria-label="설정으로 돌아가기">←</button>' +
      '<h1 class="bar-title">고급 설정</h1></div></div>' +
      '<div class="view under-1">' +
      '<p class="muted small" style="margin-bottom:14px">키·계정 연동 등 처음 한 번만 만지면 되는 항목입니다. 키는 이 기기의 브라우저에만 저장됩니다.</p>';

    /* ── AI 요약 엔진 (Gemini) ── */
    html += group('gemini', 'AI 요약 엔진 (Gemini)', apiKey ? '연동됨 ✅' : '미설정',
      '<p class="muted small" style="margin-bottom:8px">API 키를 입력하면 대화 유형(회의·강의·통화·상담 등)에 맞춘 요약·마인드맵·할 일·키워드를 Gemini가 생성하고, 노트에서 "AI에게 질문"도 쓸 수 있습니다. Google AI Studio(aistudio.google.com/apikey)에서 무료 발급, 브라우저에만 저장됨. 실패 시 기본 모드로 자동 폴백합니다.</p>' +
      '<div class="settings-row"><label>Gemini API 키</label>' +
      '<input type="password" id="st-apikey" style="flex:1;min-width:160px" placeholder="' + (apiKey ? '저장됨 (••••' + U.esc(apiKey.slice(-4)) + ')' : 'AIza…') + '">' +
      '<button class="btn btn-sm btn-primary" id="st-apikey-save">저장</button>' +
      (apiKey ? '<button class="btn btn-sm" id="st-apikey-del">삭제</button>' : '') + '</div>' +
      '<div class="settings-row"><label>요약 모델</label><select id="st-gemini-model">' +
      '<option value="gemini-3.5-flash">gemini-3.5-flash — 최상위 모델, 무료</option>' +
      '<option value="gemini-flash-latest">gemini-flash-latest — 대안, 무료 (최신 flash 자동 추종)</option></select></div>' +
      '<p class="muted small">gemini-3.5-flash는 현재 Gemini 계열에서 가장 지능적인 최상위 모델입니다(3.5 세대에 pro 변형은 없습니다). ' +
      '모델 선택은 요약에만 적용되며, 오디오 전사(Gemini 변환)는 비용이 커서 항상 gemini-3.5-flash를 사용합니다.</p>' +
      '<div class="settings-row"><label>요약 품질</label><select id="st-gemini-quality">' +
      '<option value="quality">정확도 우선 (권장, 느림)</option>' +
      '<option value="speed">속도 우선</option></select></div>' +
      '<p class="muted small">정확도 우선은 모델이 내용을 더 깊이 검토해 결정 사항과 담당자를 정확히 뽑아내지만, 요약 생성에 시간이 더 걸립니다. ' +
      '품질 설정은 요약에만 적용됩니다(오디오 전사는 항상 속도 우선).</p>');

    /* ── 자동 화자분리 API 키 ── */
    const keyRow = (id, label, val, ph) =>
      '<div class="settings-row"><label>' + label + '</label>' +
      '<input type="password" id="' + id + '" style="flex:1;min-width:160px" placeholder="' +
      (val ? '저장됨 (••••' + U.esc(val.slice(-4)) + ')' : ph) + '">' +
      '<button class="btn btn-sm btn-primary" data-keysave="' + id + '">저장</button>' +
      (val ? '<button class="btn btn-sm" data-keydel="' + id + '">삭제</button>' : '') + '</div>';

    html += group('diarize', '자동 화자분리 (Deepgram / AssemblyAI)', (dgKey || aaiKey) ? '연동됨 ✅' : '미설정',
      '<p class="muted small" style="margin-bottom:8px">자동 텍스트 변환은 Deepgram(우선) → AssemblyAI(예비) → Gemini 순으로 저장된 키를 사용합니다. Deepgram 키가 있으면 화자까지 자동으로 나눠 전사합니다. 키는 이 기기의 브라우저에만 저장됩니다.</p>' +
      keyRow('st-dg-key', 'Deepgram API 키', dgKey, '키 입력') +
      keyRow('st-aai-key', 'AssemblyAI API 키', aaiKey, '키 입력'));

    /* ── Google 계정 (OAuth) ── */
    html += group('google', 'Google 계정 (Drive API · Calendar)', gStatus.signedIn ? '로그인됨 ✅' : '미설정',
      '<p class="muted small" style="margin-bottom:8px">로그인하면 Android에서도 별도 설정 없이 회의록이 Drive에 업로드되고, 캘린더 일정으로 회의 제목·참석자를 자동으로 채웁니다. 클라이언트 ID 발급 방법은 README의 "Google Cloud 콘솔 설정"을 참고하세요.</p>' +
      '<div class="settings-row"><label>클라이언트 ID</label>' +
      '<input type="text" id="ga-clientid" style="flex:1;min-width:200px" value="' + U.esc(clientId) + '" placeholder="…apps.googleusercontent.com">' +
      '<button class="btn btn-sm btn-primary" id="ga-clientid-save">저장</button></div>' +
      '<div class="settings-row"><label>상태</label>' +
      (!gStatus.configured
        ? '<span class="muted small">클라이언트 ID를 먼저 저장하세요.</span>'
        : (gStatus.signedIn
          ? '<span class="small">✅ 로그인됨</span>'
          : (gStatus.hasToken
            ? '<span class="small" style="color:var(--danger)">로그인 만료됨 — 다시 로그인</span>'
            : '<span class="muted small">로그인 안 됨</span>'))) +
      '<button class="btn btn-sm btn-primary" id="ga-signin"' + (gStatus.configured ? '' : ' disabled') + '>' +
      (gStatus.signedIn ? '다시 로그인' : 'Google 로그인') + '</button>' +
      (gStatus.hasToken ? '<button class="btn btn-sm" id="ga-signout">로그아웃</button>' : '') + '</div>' +
      '<div class="settings-row"><label>Drive 폴더</label>' +
      (apiStatus.folderName
        ? '<span class="small">📁 ' + U.esc(apiStatus.folderName) + '</span>'
        : '<span class="muted small">아직 확인 안 됨 (저장 시 "' + U.esc(VN.drive.FOLDER_NAME) + '" 폴더를 찾거나 만듭니다)</span>') +
      '<button class="btn btn-sm" id="ga-refolder"' + (gStatus.configured ? '' : ' disabled') + '>폴더 다시 찾기</button></div>');

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

    let driveBody =
      '<p class="muted small" style="margin-bottom:8px">녹음 종료·업로드 변환 직후 회의록을 자동 저장합니다. 파일명은 <b>날짜_시각_대화주제</b>(연결된 캘린더 일정 제목 우선, 없으면 Gemini 주제·키워드)로 만들어집니다. 아래에서 고른 <b>한 경로</b>에만 저장됩니다. 자동 저장 켜기/끄기는 설정 메인의 "기본"에 있습니다.</p>' +
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
      driveBody += '<div class="settings-row"><label>PC 저장 폴더</label>' +
        (folderStatus.name
          ? '<span class="small">📁 ' + U.esc(folderStatus.name) + (folderStatus.permission === 'granted' ? '' : ' <span style="color:var(--danger)">(재승인 필요)</span>') + '</span>'
          : '<span class="muted small">선택 안 됨 — 예: G:\\내 드라이브\\회의록</span>') +
        '<button class="btn btn-sm" id="dr-pick">PC 저장 폴더 선택</button>' +
        (folderStatus.name && folderStatus.permission !== 'granted' ? '<button class="btn btn-sm btn-primary" id="dr-perm">재승인</button>' : '') +
        (folderStatus.name ? '<button class="btn btn-sm" id="dr-unpick">해제</button>' : '') +
        '</div>';
    } else {
      driveBody += '<p class="muted small">이 브라우저는 PC 폴더 저장(File System Access API)을 지원하지 않습니다. Android에서는 아래 Apps Script 웹훅을 사용하세요.</p>';
    }
    driveBody += '<div class="settings-row"><label>Apps Script URL</label><input type="text" id="dr-url" style="flex:1;min-width:160px" value="' + U.esc(hookUrl) + '" placeholder="https://script.google.com/macros/s/…/exec"></div>' +
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
      '</details>';

    html += group('drive', 'Google Drive 저장 상세',
      driveTarget !== 'none' ? U.esc(TARGET_LABEL[driveTarget] || driveTarget) : '미설정', driveBody);

    /* ── 도구 ── */
    html += group('tools', '도구', '',
      '<div class="settings-row"><label>데모 노트</label><button class="btn btn-sm btn-primary" id="st-demo">데모 노트 생성</button></div>' +
      '<p class="muted small">회의 시나리오(화자 3인·메모·북마크·하이라이트·합성 오디오)가 담긴 예시 노트를 만듭니다.</p>');

    html += '</div>';
    main().innerHTML = html;

    /* advFocus 딥링크: 해당 그룹 펼치고 스크롤 (연동 상태 카드 [관리]·오류 안내에서 진입) */
    let advFocus = null;
    try { advFocus = sessionStorage.getItem('advFocus'); sessionStorage.removeItem('advFocus'); } catch (e) { }
    if (advFocus) {
      const g = $('#adv-' + advFocus);
      if (g) {
        g.open = true;
        setTimeout(() => g.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
      }
    }

    /* 저장 후 재렌더 — 스크롤 위치와 펼침 상태 유지, 고급 설정이 열려 있을 때만
       (async 핸들러가 끝났을 때 이미 다른 화면으로 이동했을 수 있다) */
    const rerender = () => {
      if (!location.hash.startsWith('#/settings/advanced')) return;
      const y = window.scrollY;
      const opened = $$('details.settings-group').filter(d => d.open).map(d => d.id);
      viewSettingsAdvanced().then(() => {
        opened.forEach(id => { const d = document.getElementById(id); if (d) d.open = true; });
        window.scrollTo(0, y);
      });
    };

    $('#st-back').onclick = () => go('#/settings');

    $('#st-gemini-model').value = VN.summarizer.SUMMARY_MODELS.indexOf(geminiModel) !== -1 ? geminiModel : VN.summarizer.DEFAULT_MODEL;
    $('#st-gemini-model').onchange = async (e) => {
      await VN.db.setSetting('geminiModel', e.target.value);
      toast('요약 모델을 변경했습니다.');
    };
    $('#st-gemini-quality').value = VN.summarizer.pickQuality(geminiQuality);
    $('#st-gemini-quality').onchange = async (e) => {
      await VN.db.setSetting('geminiQuality', e.target.value);
      toast(e.target.value === 'quality' ? '정확도 우선으로 변경했습니다.' : '속도 우선으로 변경했습니다.');
    };
    $('#st-apikey-save').onclick = async () => {
      const v = $('#st-apikey').value.trim();
      if (!v) { toast('API 키를 입력하세요.'); return; }
      await VN.db.setSetting('geminiApiKey', v);
      toast('API 키를 저장했습니다.');
      rerender();
    };
    if ($('#st-apikey-del')) $('#st-apikey-del').onclick = async () => {
      await VN.db.setSetting('geminiApiKey', '');
      toast('API 키를 삭제했습니다.');
      rerender();
    };
    /* 키 입력칸에서 Enter 로도 저장되게 (버튼을 못 찾는 경우가 많아 추가) */
    [['#st-apikey', '#st-apikey-save'], ['#ga-clientid', '#ga-clientid-save'],
     ['#dr-url', '#dr-hook-save'], ['#dr-token', '#dr-hook-save'],
     ['#st-dg-key', '[data-keysave="st-dg-key"]'], ['#st-aai-key', '[data-keysave="st-aai-key"]']]
      .forEach(([input, button]) => {
        const el = $(input), btn = $(button);
        if (el && btn) el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.click(); } };
      });
    /* Drive 설정 핸들러 (자동 저장 ON/OFF는 설정 메인) */
    $('#dr-fmt').onchange = (e) => VN.db.setSetting('driveFormat', e.target.value);
    $('#dr-audio').onchange = (e) => VN.db.setSetting('driveAudio', e.target.checked);
    if ($('#dr-pick')) $('#dr-pick').onclick = async () => {
      try {
        const name = await VN.drive.pickFolder();
        toast('저장 폴더를 설정했습니다: ' + name);
        rerender();
      } catch (e) { if (!e || e.name !== 'AbortError') toast('폴더 선택 실패: ' + ((e && e.message) || e)); }
    };
    if ($('#dr-perm')) $('#dr-perm').onclick = async () => {
      const p = await VN.drive.requestFolderPermission();
      toast(p === 'granted' ? '폴더 접근이 승인되었습니다.' : '승인되지 않았습니다.');
      rerender();
    };
    if ($('#dr-unpick')) $('#dr-unpick').onclick = async () => {
      await VN.drive.clearFolder();
      toast('저장 폴더를 해제했습니다.');
      rerender();
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
      rerender();
    });
    $$('[data-keydel]').forEach(b => b.onclick = async () => {
      await VN.db.setSetting(KEY_SETTING[b.dataset.keydel], '');
      toast('키를 삭제했습니다.');
      rerender();
    });

    /* Google 계정 */
    $('#ga-clientid-save').onclick = async () => {
      await VN.gauth.setClientId($('#ga-clientid').value.trim());
      toast('클라이언트 ID를 저장했습니다.');
      rerender();
    };
    $('#ga-signin').onclick = async () => {
      const b = $('#ga-signin');
      b.disabled = true; b.textContent = '로그인 중…';
      try {
        await VN.gauth.signIn();
        toast('Google 계정에 로그인했습니다.');
      } catch (e) { toast('로그인 실패: ' + ((e && e.message) || e)); }
      rerender();
    };
    if ($('#ga-signout')) $('#ga-signout').onclick = async () => {
      await VN.gauth.signOut();
      toast('로그아웃했습니다.');
      rerender();
    };
    $('#ga-refolder').onclick = async () => {
      const b = $('#ga-refolder');
      b.disabled = true; b.textContent = '찾는 중…';
      try {
        const f = await VN.drive.resolveFolder(true);
        toast('Drive 폴더: ' + f.name);
      } catch (e) { toast('폴더 확인 실패: ' + ((e && e.message) || e)); }
      rerender();
    };
    $('#st-demo').onclick = async () => {
      const btn = $('#st-demo');
      btn.disabled = true; btn.textContent = '생성 중…';
      try {
        const note = await VN.demo.seedDemo();
        invalidateNotesCache();
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
    // 다음 로드에서 CSS 적용 전에 쓸 수 있게 미러 (index.html head 인라인 스크립트가 읽음 — FOUC 방지)
    try { localStorage.setItem('vnTheme', dark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
  }

  /* ══════════════ 초기화 ══════════════ */

  async function init() {
    // 테마
    const theme = await VN.db.getSetting('theme', 'system');
    applyTheme(theme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (S.theme === 'system') applyTheme('system');
    });

    // 하단 내비게이션 (모든 화면 공통)
    $('#nav-search').onclick = () => go('#/search');
    $('#nav-record').onclick = () => go('#/record');
    $('#nav-settings').onclick = () => go('#/settings');

    $('#file-input').onchange = (e) => { if (e.target.files.length) { importFiles(e.target.files); e.target.value = ''; } };
    $('#restore-input').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const r = await VN.db.restoreBackup(data);
        invalidateNotesCache();
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

    // 녹음 중·텍스트 변환 중 새로고침·닫기 확인
    // (변환 중 탭을 닫으면 진행 중 요청은 끊기지만, 다음 실행 때 자동으로 이어서 처리된다)
    window.addEventListener('beforeunload', (e) => {
      if ((S.rec && S.rec.active) || VN.transcribe.activeCount() > 0) { e.preventDefault(); e.returnValue = ''; }
    });

    // 탭 복귀: Wake Lock 재획득 + 백그라운드 STT 중단 감지.
    // 캡처 관련(MediaRecorder·STT·flush)은 여기서 아무것도 멈추지 않는다.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !S.rec || !S.rec.active) return;
      const wl = $('#rec-wakelock-btn');
      if (wl && wl.classList.contains('on')) acquireWakeLock();
      if (S.rec.sttOn && !S.rec.sttWarned && Date.now() - VN.stt.lastResultAt() > 60000) {
        S.rec.sttWarned = true;
        const warn = $('#rec-warn');
        if (warn) warn.innerHTML = '<div class="banner">백그라운드 동안 음성인식이 일부 중단됐을 수 있습니다. 녹음은 계속 저장되고 있으니, 저장 후 노트의 🎤 "다시 변환(자동)"으로 전체를 다시 전사할 수 있습니다.</div>';
      }
    });

    // 자동 전사 진행 알림: 노트를 보고 있으면 인라인 배너(변환 중 → AI 정리 중 → Drive 저장됨 ✓),
    // 노트 밖에 있을 때만 완료 토스트 1개. 편집 중이면 재렌더를 미룬다(입력 증발 방지).
    VN.transcribe.setListener(async (note, phase) => {
      invalidateNotesCache();
      const hash = location.hash || '#/list';
      const viewing = S.note && S.note.id === note.id && hash.startsWith('#/note/');
      if (phase === 'done') {
        if (!viewing) toast('"' + note.title + '" 텍스트 변환 완료 (' + (note.segments || []).length + '개 구간)');
      } else if (phase === 'error' || phase === 'blocked') {
        toast(note.transcribeError || '텍스트 변환에 실패했습니다.', 5000);
      }
      if (viewing) {
        if (phase === 'start') setNotePipe(note.id, '⏳ 자동 텍스트 변환 중 — 화면을 이동해도 계속됩니다.');
        else if (isEditingDom()) toast('처리가 끝났습니다. 편집을 마치면 새로 고쳐집니다.');
        else await viewNote(note.id);
      }
      else if (hash === '' || hash === '#' || hash.startsWith('#/list') || hash.startsWith('#/fav') || hash.startsWith('#/folder')) await route();
      // 변환 성공 → (설정 시) AI 정리 자동 생성 → Drive 자동 저장 1회.
      // 요약을 먼저 만들어야 Drive 문서에 AI 정리가 담기고 파일명 주제도 좋아진다.
      // 요약이 실패해도 전사 결과는 보존되고 Drive 저장은 그대로 진행된다.
      // (변환 실패 시에는 요약 없이 바로 저장 — 오디오·메모라도 남긴다)
      if (phase === 'done' || phase === 'error') {
        (async () => {
          if (phase === 'done') await autoSummarizeAfter(note.id);
          const fresh = await VN.db.getNote(note.id).catch(() => null);
          driveAutoSaveAfter(fresh || note);
        })();
      }
    });
    // 지난 세션에서 끊긴 변환(pending 노트) 자동 재개 — "창을 닫아도 됨"의 웹 구현
    VN.transcribe.resumePending().then(n => {
      if (n) toast('진행 중이던 텍스트 변환 ' + n + '건을 재개했습니다.');
    }).catch(() => { /* ignore */ });

    // 크래시 복구·Drive 권한 배너·웹훅 재시도 큐·배포 감지
    checkRecovery();
    checkDrivePermission();
    initDeployWatch();
    VN.drive.flushRetryQueue().then(r => {
      if (r.sent) toast('대기 중이던 Drive 웹훅 ' + r.sent + '건을 전송했습니다.');
    }).catch(() => { /* ignore */ });

    window.addEventListener('hashchange', route);
    await route();
  }

  return {
    init, route, go, toast,
    refresh: () => refresh(true),             // 외부 호출은 항상 강제 재조회 (demo 등)
    searchNotes, replaceInNote, isMobileUA,   // 순수 함수 (셀프테스트용)
    importFiles, notifyAuthExpired,
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
