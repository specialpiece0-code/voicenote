/* VN.db — IndexedDB 래퍼 (notes/folders/trash/settings CRUD, 백업/복원)
   VN.util — 공용 유틸 (가장 먼저 로드되는 파일이므로 여기 정의) */
window.VN = window.VN || {};

/* ── 유틸 ─────────────────────────────── */
VN.util = {
  uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  },
  /* 초 → "MM:SS" 또는 "H:MM:SS" */
  fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  },
  fmtDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '. ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  },
  fmtDateShort(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  },
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  escRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); },
  debounce(fn, ms) {
    let t = null;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  },
  blobToBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  },
  blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  },
  base64ToBlob(b64, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || 'application/octet-stream' });
  }
};

/* ── IndexedDB ────────────────────────── */
VN.db = (function () {
  const DB_NAME = 'voicenote';
  const DB_VER = 2; // v2: recChunks (녹음 크래시 세이프 청크·메타)
  const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // 30일
  let _db = null;

  function open() {
    return new Promise((res, rej) => {
      if (_db) return res(_db);
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('trash')) db.createObjectStore('trash', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('recChunks')) db.createObjectStore('recChunks', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        _db = req.result;
        // 다른 탭이 상위 버전으로 업그레이드하려 할 때 연결을 닫아 차단을 방지
        _db.onversionchange = () => { try { _db.close(); } catch (e) { /* ignore */ } _db = null; };
        res(_db);
      };
      req.onerror = () => rej(req.error);
      req.onblocked = () => {
        console.warn('IndexedDB 업그레이드가 다른 탭에 의해 차단됨 — 이 앱을 연 다른 탭을 닫아주세요.');
      };
    });
  }

  function pReq(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function put(store, val) {
    const db = await open();
    return pReq(db.transaction(store, 'readwrite').objectStore(store).put(val));
  }
  async function get(store, key) {
    const db = await open();
    return pReq(db.transaction(store, 'readonly').objectStore(store).get(key));
  }
  async function getAll(store) {
    const db = await open();
    return pReq(db.transaction(store, 'readonly').objectStore(store).getAll());
  }
  async function del(store, key) {
    const db = await open();
    return pReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
  }
  async function clear(store) {
    const db = await open();
    return pReq(db.transaction(store, 'readwrite').objectStore(store).clear());
  }

  /* ── 노트 ── */
  function newNote(partial) {
    return Object.assign({
      id: VN.util.uid(),
      title: '새 노트',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      folderId: null,
      favorite: false,
      language: 'ko-KR',
      duration: 0,
      audioBlob: null,      // Blob 그대로 저장
      audioType: '',
      sourceType: 'record', // record | upload | demo
      tags: [],
      speakers: [{ name: '참석자 1' }],
      segments: [],         // {id, speaker, start, end, text, bookmarked, highlighted}
      memos: [],            // {id, time, text, createdAt}
      bookmarks: [],        // {id, time} 녹음 중 시점 북마크
      summary: null,        // {summary, topics:[{title,summary,start}], todos:[], keywords:[], mode}
      waveform: null        // number[] 파형 피크
    }, partial || {});
  }

  async function saveNote(note) { note.updatedAt = Date.now(); await put('notes', note); return note; }
  async function getNote(id) { return get('notes', id); }
  async function getAllNotes() { return getAll('notes'); }

  /* 삭제 → 휴지통(30일 보관) */
  async function trashNote(id) {
    const note = await get('notes', id);
    if (!note) return;
    note.deletedAt = Date.now();
    await put('trash', note);
    await del('notes', id);
  }
  async function restoreNote(id) {
    const note = await get('trash', id);
    if (!note) return null;
    delete note.deletedAt;
    await put('notes', note);
    await del('trash', id);
    return note;
  }
  async function purgeNote(id) { return del('trash', id); }
  async function emptyTrash() { return clear('trash'); }
  async function getTrash() {
    const items = await getAll('trash');
    return items.sort((a, b) => b.deletedAt - a.deletedAt);
  }
  /* 30일 지난 휴지통 항목 자동 영구삭제 */
  async function purgeExpiredTrash() {
    const items = await getAll('trash');
    const now = Date.now();
    let n = 0;
    for (const it of items) {
      if (now - (it.deletedAt || 0) > TRASH_KEEP_MS) { await del('trash', it.id); n++; }
    }
    return n;
  }

  /* ── 폴더 ── */
  async function saveFolder(folder) {
    if (!folder.id) folder.id = VN.util.uid();
    if (!folder.createdAt) folder.createdAt = Date.now();
    await put('folders', folder);
    return folder;
  }
  async function getFolders() {
    const fs = await getAll('folders');
    return fs.sort((a, b) => a.createdAt - b.createdAt);
  }
  /* 폴더 삭제 시 내부 노트는 전체 노트(folderId=null)로 이동 */
  async function deleteFolder(id) {
    const notes = await getAllNotes();
    for (const n of notes) {
      if (n.folderId === id) { n.folderId = null; await put('notes', n); }
    }
    await del('folders', id);
  }

  /* ── 설정 ── */
  async function getSetting(key, def) {
    const row = await get('settings', key);
    return row ? row.value : def;
  }
  async function setSetting(key, value) { return put('settings', { key, value }); }

  /* ── 백업/복원 ── */
  async function backup(includeAudio) {
    const [notes, folders, trash, settings] = await Promise.all([
      getAll('notes'), getAll('folders'), getAll('trash'), getAll('settings')
    ]);
    async function serializeNote(n) {
      const copy = Object.assign({}, n);
      if (n.audioBlob instanceof Blob) {
        if (includeAudio) {
          copy.audioB64 = await VN.util.blobToBase64(n.audioBlob);
          copy.audioType = n.audioBlob.type || n.audioType || '';
        }
        delete copy.audioBlob;
        copy.hadAudio = true;
      }
      return copy;
    }
    const sNotes = [], sTrash = [];
    for (const n of notes) sNotes.push(await serializeNote(n));
    for (const n of trash) sTrash.push(await serializeNote(n));
    return {
      app: 'voicenote', version: 1, exportedAt: Date.now(),
      includeAudio: !!includeAudio,
      notes: sNotes, folders, trash: sTrash, settings
    };
  }

  async function restoreBackup(data) {
    if (!data || data.app !== 'voicenote' || !Array.isArray(data.notes)) {
      throw new Error('보이스노트 백업 파일이 아닙니다.');
    }
    function deserializeNote(n) {
      const copy = Object.assign({}, n);
      if (copy.audioB64) {
        try { copy.audioBlob = VN.util.base64ToBlob(copy.audioB64, copy.audioType); } catch (e) { copy.audioBlob = null; }
        delete copy.audioB64;
      }
      return copy;
    }
    for (const f of (data.folders || [])) await put('folders', f);
    for (const n of data.notes) await put('notes', deserializeNote(n));
    for (const n of (data.trash || [])) await put('trash', deserializeNote(n));
    for (const s of (data.settings || [])) {
      if (s && s.key) await put('settings', s);
    }
    return { notes: data.notes.length, folders: (data.folders || []).length };
  }

  async function wipeAll() {
    await clear('notes'); await clear('folders'); await clear('trash'); await clear('settings');
  }

  return {
    open, put, get, getAll, del, clear,
    newNote, saveNote, getNote, getAllNotes,
    trashNote, restoreNote, purgeNote, emptyTrash, getTrash, purgeExpiredTrash,
    saveFolder, getFolders, deleteFolder,
    getSetting, setSetting,
    backup, restoreBackup, wipeAll,
    TRASH_KEEP_MS
  };
})();
