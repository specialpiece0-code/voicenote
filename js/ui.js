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
      '<button class="icon-btn" id="btn-del-note" title="삭제">🗑</button>' +
      '</div>' +
      '<div class="note-info">' +
      '<span>' + U.fmtDate(note.createdAt) + '</span>' +
      '<span>⏱ ' + U.fmtTime(note.duration) + '</span>' +
      '<span>' + (LANG_LABEL[note.language] || note.language || '-') + '</span>' +
      (note.tags || []).map(t => '<span class="tag green">#' + U.esc(t) + '</span>').join('') +
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
    html += '<div class="settings-row" style="justify-content:center"><label>인식 언어</label>' +
      '<select id="rec-lang">' +
      '<option value="ko-KR">한국어</option><option value="en-US">영어 (미국)</option>' +
      '<option value="ja-JP">일본어</option><option value="zh-CN">중국어 (간체)</option></select></div>' +
      '<div class="record-timer" id="rec-timer">00:00</div>' +
      '<div class="record-state" id="rec-state">녹음 대기 중</div>' +
      '<canvas id="record-wave" width="640" height="90"></canvas>' +
      '<div class="record-controls" id="rec-controls">' +
      '<button class="btn btn-primary" id="rec-start"' + (recSupported ? '' : ' disabled') + '>● 녹음 시작</button>' +
      '</div>' +
      '<div class="speaker-tabs" id="rec-speakers"></div>' +
      '<div class="stt-live" id="stt-live"><span class="faint">녹음을 시작하면 실시간 자막이 여기에 표시됩니다.</span></div>' +
      '<div class="record-memo-row">' +
      '<button class="icon-btn" id="rec-bookmark" title="현재 시점 북마크" disabled>🔖</button>' +
      '<input type="text" id="rec-memo" placeholder="타임스탬프 메모 입력 후 Enter" disabled>' +
      '</div></div>';
    main().innerHTML = html;

    VN.db.getSetting('defaultLang', 'ko-KR').then(l => { $('#rec-lang') && ($('#rec-lang').value = l); });

    S.rec = {
      active: false, lang: 'ko-KR',
      segments: [], memos: [], bookmarks: [],
      speakers: [{ name: '참석자 1' }, { name: '참석자 2' }, { name: '참석자 3' }],
      curSpeaker: 0, timerId: null
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
      S.rec.timerId = setInterval(() => {
        const t = $('#rec-timer');
        if (t) t.textContent = U.fmtTime(VN.recorder.currentTime());
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
          go('#/list');
        }
      };
    };

    $('#rec-start').onclick = async () => {
      S.rec.lang = $('#rec-lang').value;
      VN.db.setSetting('defaultLang', S.rec.lang);
      try {
        await VN.recorder.start({ canvas: $('#record-wave') });
      } catch (e) {
        toast('녹음을 시작할 수 없습니다: ' + (e.message || e));
        return;
      }
      S.rec.active = true;
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
    const title = dateStr + ' ' + (kws[0] || '녹음');

    const note = VN.db.newNote({
      title,
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
    S.rec = null;
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

  function transcribeChoiceModal(note) {
    const m = modal('<h2>텍스트 변환</h2><div class="modal-body">' +
      '<p class="muted" style="margin-bottom:10px">"' + U.esc(note.title) + '" 노트를 만들었습니다. 어떻게 텍스트로 변환할까요?</p>' +
      '<button class="btn btn-block" id="tc-manual" style="margin-bottom:8px">✍️ 수동 전사 (구간을 추가하며 직접 입력)</button>' +
      '<button class="btn btn-block" id="tc-whisper" style="margin-bottom:8px">🤖 Whisper AI 변환 (인터넷 필요)</button>' +
      '<button class="btn btn-ghost btn-block" id="tc-later">나중에 하기</button></div>');
    $('#tc-later', m).onclick = () => { m.remove(); go('#/note/' + note.id); };
    $('#tc-manual', m).onclick = () => { m.remove(); go('#/note/' + note.id); toast('음성 기록 탭의 "구간 추가"로 전사를 입력하세요.'); };
    $('#tc-whisper', m).onclick = () => { m.remove(); whisperModal(note); };
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
        go('#/note/' + note.id);
      } catch (e) {
        const st = $('#wh-status', m);
        if (st) st.innerHTML = '<span style="color:var(--danger)">' + U.esc(e.message || String(e)) + '</span>';
        btn.disabled = false;
      }
    };
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
    const [lang, theme, apiKey] = await Promise.all([
      VN.db.getSetting('defaultLang', 'ko-KR'),
      VN.db.getSetting('theme', 'system'),
      VN.db.getSetting('geminiApiKey', '')
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
