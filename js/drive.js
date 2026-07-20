/* VN.drive — 회의록 Google Drive 자동 저장
   A1: File System Access API로 PC 폴더(Google Drive for Desktop 마운트 폴더)에 직접 쓰기
   A2: Apps Script 웹훅(POST text/plain 단순 요청 — 커스텀 헤더 금지로 preflight 회피)
   파일명: YYYY-MM-DD_HHmm_<대화주제>.doc (주제: Gemini → 로컬 키워드 폴백) */
window.VN = window.VN || {};

VN.drive = (function () {
  const fsSupported = typeof window.showDirectoryPicker === 'function';
  const MAX_PAYLOAD = 18 * 1024 * 1024; // 웹훅 페이로드 18MB 제한

  /* ══════════ A1: PC 폴더 (File System Access API) ══════════ */

  async function getDirHandle() {
    try { return await VN.db.getSetting('driveDirHandle', null); } catch (e) { return null; }
  }

  async function pickFolder() {
    if (!fsSupported) throw new Error('이 브라우저는 폴더 저장(File System Access API)을 지원하지 않습니다.');
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await VN.db.setSetting('driveDirHandle', handle); // 핸들은 구조화 복제로 IndexedDB에 저장 가능
    return handle.name;
  }

  async function clearFolder() { await VN.db.setSetting('driveDirHandle', null); }

  /* {supported, name, permission:'granted'|'prompt'|'none', ready} */
  async function getFolderStatus() {
    if (!fsSupported) return { supported: false, name: null, permission: 'none', ready: false };
    const h = await getDirHandle();
    if (!h) return { supported: true, name: null, permission: 'none', ready: false };
    let perm = 'prompt';
    try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
    return { supported: true, name: h.name, permission: perm, ready: perm === 'granted' };
  }

  /* 사용자 제스처(배너/설정 버튼)에서만 호출 */
  async function requestFolderPermission() {
    const h = await getDirHandle();
    if (!h) return 'none';
    try { return await h.requestPermission({ mode: 'readwrite' }); } catch (e) { return 'prompt'; }
  }

  async function fileExists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
  }

  /* 폴더에 쓰기. reuse=true면 같은 이름 덮어쓰기(재저장), 아니면 " (2)" 유니크화 */
  async function writeToFolder(filename, data, reuse) {
    const dir = await getDirHandle();
    if (!dir) throw new Error('저장 폴더가 설정되지 않았습니다.');
    let perm = 'prompt';
    try { perm = await dir.queryPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
    if (perm !== 'granted') throw new Error('폴더 접근 권한이 없습니다. 상단 배너 또는 설정에서 재승인해 주세요.');
    let final = filename;
    if (!reuse) {
      const m = filename.match(/^(.*?)(\.[^.]+)?$/);
      const base = m[1], ext = m[2] || '';
      let n = 2;
      while (await fileExists(dir, final)) { final = base + ' (' + n + ')' + ext; n++; }
    }
    const fh = await dir.getFileHandle(final, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
    return final;
  }

  /* ══════════ A2: Apps Script 웹훅 ══════════ */

  /* 순수 함수 — 셀프테스트에서 직렬화/역직렬화 검증 */
  function buildWebhookPayload(token, filename, mimeType, dataBase64) {
    return JSON.stringify({ token, filename, mimeType, dataBase64 });
  }

  async function sendWebhook(filename, mimeType, dataBase64) {
    const url = await VN.db.getSetting('appsScriptUrl', '');
    const token = await VN.db.getSetting('appsScriptToken', '');
    if (!url || !token) throw new Error('Apps Script URL/토큰이 설정되지 않았습니다.');
    const body = buildWebhookPayload(token, filename, mimeType, dataBase64);
    if (body.length > MAX_PAYLOAD) {
      const e = new Error('페이로드가 18MB를 초과하여 웹훅 전송을 건너뜁니다.');
      e.tooBig = true;
      throw e;
    }
    // 커스텀 헤더 없이 text/plain 단순 요청 → CORS preflight 없음
    const opt = { method: 'POST', body };
    try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(30000); } catch (e) { /* ignore */ }
    const resp = await fetch(url, opt);
    if (!resp.ok) throw new Error('웹훅 HTTP 오류 (' + resp.status + ')');
    let j;
    try { j = await resp.json(); } catch (e) { throw new Error('웹훅 응답(JSON)을 해석하지 못했습니다.'); }
    if (!j.ok) throw new Error('웹훅 오류: ' + (j.error || '알 수 없음'));
    return j;
  }

  /* ── 재시도 큐 (설정 store에 보관, 앱 시작 시 재전송) ── */
  async function enqueueRetry(item) {
    const q = await VN.db.getSetting('driveRetryQueue', []);
    q.push(Object.assign({ ts: Date.now() }, item));
    await VN.db.setSetting('driveRetryQueue', q.slice(-20));
  }

  async function flushRetryQueue() {
    const q = await VN.db.getSetting('driveRetryQueue', []);
    if (!q.length) return { sent: 0, left: 0 };
    const left = [];
    let sent = 0;
    for (const item of q) {
      try {
        await sendWebhook(item.filename, item.mimeType, item.dataBase64);
        sent++;
      } catch (e) {
        if (!e.tooBig) left.push(item); // 18MB 초과는 폐기
      }
    }
    await VN.db.setSetting('driveRetryQueue', left);
    return { sent, left: left.length };
  }

  /* ══════════ A2-b: 정식 Drive API (VN.gauth 토큰 사용) ══════════ */

  const FOLDER_NAME = '회의록';

  /* Drive 검색 쿼리 문자열 리터럴 이스케이프 */
  function escQuery(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /* 순수 함수 — multipart/related 본문 조립 (셀프테스트에서 파싱 검증) */
  function buildMultipartBody(metadata, mimeType, base64Data, boundary) {
    const b = boundary || 'vn-boundary';
    return '--' + b + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + b + '\r\n' +
      'Content-Type: ' + (mimeType || 'application/octet-stream') + '\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      (base64Data || '') + '\r\n' +
      '--' + b + '--';
  }

  function newBoundary() {
    return 'vn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function apiFindFolder() {
    const q = "name='" + escQuery(FOLDER_NAME) + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(id,name)');
    const resp = await VN.gauth.authFetch(url, { method: 'GET' });
    if (!resp.ok) throw new Error('폴더 조회 실패 (HTTP ' + resp.status + ')');
    const j = await resp.json();
    return (j.files && j.files[0]) || null;
  }

  async function apiCreateFolder() {
    const resp = await VN.gauth.authFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!resp.ok) throw new Error('폴더 생성 실패 (HTTP ' + resp.status + ')');
    return resp.json();
  }

  /* 설정에 저장된 폴더 ID 사용, 없거나 force면 이름으로 찾고 없으면 생성 */
  async function resolveFolder(force) {
    if (!force) {
      const id = await VN.db.getSetting('driveFolderId', '');
      if (id) return { id, name: await VN.db.getSetting('driveFolderName', FOLDER_NAME) };
    }
    let f = await apiFindFolder();
    if (!f) f = await apiCreateFolder();
    await VN.db.setSetting('driveFolderId', f.id);
    await VN.db.setSetting('driveFolderName', f.name || FOLDER_NAME);
    return { id: f.id, name: f.name || FOLDER_NAME };
  }

  async function apiFindFile(folderId, name) {
    const q = "name='" + escQuery(name) + "' and '" + escQuery(folderId) + "' in parents and trashed=false";
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(id,name)');
    const resp = await VN.gauth.authFetch(url, { method: 'GET' });
    if (!resp.ok) throw new Error('파일 조회 실패 (HTTP ' + resp.status + ')');
    const j = await resp.json();
    return (j.files && j.files[0]) || null;
  }

  /* 같은 폴더에 같은 이름이 있으면 덮어쓰기(PATCH media), 없으면 생성(POST multipart).
     용량 제한 없음 — 웹훅의 18MB 제한은 이 경로에 적용하지 않는다. */
  async function apiUpload(filename, mimeType, blob, folderId) {
    const existing = await apiFindFile(folderId, filename);
    let resp;
    if (existing) {
      resp = await VN.gauth.authFetch(
        'https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(existing.id) +
        '?uploadType=media&fields=' + encodeURIComponent('id,name,webViewLink'),
        { method: 'PATCH', headers: { 'Content-Type': mimeType || 'application/octet-stream' }, body: blob }
      );
    } else {
      const b64 = await VN.util.blobToBase64(blob);
      const boundary = newBoundary();
      const body = buildMultipartBody({ name: filename, parents: [folderId] }, mimeType, b64, boundary);
      resp = await VN.gauth.authFetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=' +
        encodeURIComponent('id,name,webViewLink'),
        { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body }
      );
    }
    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = (j.error && j.error.message) || ''; } catch (e) { /* ignore */ }
      throw new Error('업로드 실패 (HTTP ' + resp.status + (detail ? ': ' + detail : '') + ')');
    }
    return resp.json();
  }

  /* {configured, signedIn, folderId, folderName} */
  async function getApiStatus() {
    let st = { configured: false, signedIn: false, hasToken: false, email: '' };
    try { st = await VN.gauth.status(); } catch (e) { /* ignore */ }
    return {
      configured: st.configured,
      signedIn: st.signedIn || st.hasToken,
      email: st.email,
      folderId: await VN.db.getSetting('driveFolderId', ''),
      folderName: await VN.db.getSetting('driveFolderName', '')
    };
  }

  /* ══════════ A3: 파일명·주제 ══════════ */

  function sanitizeFilename(s) {
    return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  }

  /* 순수 함수 — 셀프테스트 대상 */
  function makeFilename(note, topic, ext) {
    const d = new Date((note && note.createdAt) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
    const t = sanitizeFilename(topic).slice(0, 15).trim() || '회의록';
    return stamp + '_' + t + '.' + (ext || 'doc');
  }

  /* 로컬 폴백: 키워드 상위 2개 */
  function localTopic(note) {
    const text = (note.segments || []).map(s => s.text || '').join(' ');
    const kws = text ? VN.summarizer.keywords(text, 2) : [];
    return kws.join(' ') || sanitizeFilename(note.title || '').slice(0, 15) || '회의록';
  }

  /* Gemini로 15자 이내 핵심 주제 생성, 실패·키 없음 시 로컬 폴백 */
  async function generateTopic(note) {
    const apiKey = await VN.db.getSetting('geminiApiKey', '');
    if (apiKey && (note.segments || []).some(s => s.text && s.text.trim())) {
      try {
        const head = (note.segments || []).slice(0, 40).map(s => s.text).join(' ').slice(0, 4000);
        const sum = (note.summary && note.summary.summary) || '';
        const prompt = '다음 회의 내용의 핵심 주제를 한국어 15자 이내의 명사구 하나로만 답하세요. 따옴표·마침표·설명 금지.\n\n' +
          (sum ? '[요약]\n' + sum + '\n\n' : '') + '[대화 앞부분]\n' + head;
        const opt = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } }
          })
        };
        try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(12000); } catch (e) { /* ignore */ }
        const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', opt);
        if (resp.ok) {
          const data = await resp.json();
          let t = (data.candidates && data.candidates[0] && data.candidates[0].content &&
            data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
            data.candidates[0].content.parts[0].text) || '';
          t = String(t).split('\n')[0].replace(/["'「」『』.]/g, '').trim();
          if (t) return t.slice(0, 15);
        }
      } catch (e) { /* 폴백 */ }
    }
    return localTopic(note).slice(0, 15);
  }

  /* ══════════ A4: 저장 오케스트레이션 ══════════ */

  async function setLastResult(ok, message) {
    try { await VN.db.setSetting('driveLastResult', { time: Date.now(), ok: !!ok, message: message || '' }); } catch (e) { /* ignore */ }
  }
  async function getLastResult() { return VN.db.getSetting('driveLastResult', null); }

  /* 저장 경로 선택: 'folder' | 'api' | 'webhook' | 'none'
     미설정(기존 사용자)이면 설정된 것에서 자동 판단 — 기존 설정을 지우지 않는다. */
  async function getTarget() {
    const t = await VN.db.getSetting('driveTarget', '');
    if (t) return t;
    const api = await getApiStatus();
    if (api.signedIn) return 'api';
    const dir = await getFolderStatus();
    if (dir.ready || dir.name) return 'folder';
    const url = await VN.db.getSetting('appsScriptUrl', '');
    const tok = await VN.db.getSetting('appsScriptToken', '');
    if (url && tok) return 'webhook';
    return 'none';
  }
  async function setTarget(t) { await VN.db.setSetting('driveTarget', t); }

  /* 캘린더 일정 제목이 있으면 그것을 주제로 우선 사용 (15자 초과 시 자름) — 순수 함수 */
  function calendarTopic(note) {
    const t = (note && note.calendar && note.calendar.title) || '';
    return sanitizeFilename(t).slice(0, 15).trim();
  }

  /* 선택된 경로 하나에 저장.
     최초 저장: 주제 결정(캘린더 제목 우선 → Gemini → 로컬) → 파일명 확정 → 노트 제목 갱신.
     재저장: note.driveFilename 유지·덮어쓰기(폴더·Drive API 경로). */
  async function saveNoteToDrive(note) {
    const fmt = await VN.db.getSetting('driveFormat', 'doc');   // 'doc' | 'txt'
    const withAudio = await VN.db.getSetting('driveAudio', false);
    const target = await getTarget();
    if (target === 'none') {
      return { saved: false, noPath: true, message: '저장 경로가 "사용 안 함"으로 설정되어 있습니다.' };
    }

    const dirStatus = await getFolderStatus();
    const hookUrl = await VN.db.getSetting('appsScriptUrl', '');
    const hookToken = await VN.db.getSetting('appsScriptToken', '');
    const apiStatus = await getApiStatus();
    const useDir = target === 'folder';
    const useHook = target === 'webhook';
    const useApi = target === 'api';

    if (useDir && !dirStatus.ready) {
      return {
        saved: false, noPath: true,
        message: (dirStatus.name && dirStatus.permission === 'prompt')
          ? 'Drive 폴더 재승인이 필요합니다. (상단 배너 또는 설정)'
          : 'PC 저장 폴더가 선택되지 않았습니다. (설정에서 폴더 선택)'
      };
    }
    if (useHook && !(hookUrl && hookToken)) {
      return { saved: false, noPath: true, message: 'Apps Script URL/토큰이 설정되지 않았습니다.' };
    }
    if (useApi && !apiStatus.signedIn) {
      return {
        saved: false, noPath: true,
        message: apiStatus.configured
          ? 'Google 로그인이 필요합니다. (설정 → Google 계정)'
          : 'Google 클라이언트 ID가 설정되지 않았습니다. (설정 → Google 계정)'
      };
    }

    const firstSave = !note.driveFilename;
    let filename = note.driveFilename;
    if (firstSave) {
      const calTopic = calendarTopic(note);
      const topic = calTopic || await generateTopic(note);
      if (!calTopic && topic) note.title = topic; // 같은 주제로 노트 제목도 갱신 (캘린더 제목은 이미 반영됨)
      filename = makeFilename(note, topic, fmt);
    }

    const content = fmt === 'txt' ? VN.exporter.toTXT(note, {}) : VN.exporter.toDOC(note, {});
    const mime = fmt === 'txt' ? 'text/plain' : 'application/msword';
    const okParts = [], errParts = [];

    if (useDir) {
      try {
        filename = await writeToFolder(filename, content, !firstSave);
        okParts.push('PC 폴더(' + dirStatus.name + ')');
      } catch (e) { errParts.push('폴더: ' + (e.message || e)); }
    }
    if (useHook) {
      try {
        const b64 = await VN.util.blobToBase64(new Blob([content], { type: mime }));
        await sendWebhook(filename, mime, b64);
        okParts.push('웹훅(Drive)');
      } catch (e) {
        if (e.tooBig) errParts.push('웹훅: 18MB 초과로 건너뜀');
        else {
          try {
            const b64 = await VN.util.blobToBase64(new Blob([content], { type: mime }));
            await enqueueRetry({ filename, mimeType: mime, dataBase64: b64 });
            errParts.push('웹훅 실패 → 재시도 큐 보관 (' + (e.message || e) + ')');
          } catch (e2) { errParts.push('웹훅: ' + (e.message || e)); }
        }
      }
    }
    if (useApi) {
      try {
        const folder = await resolveFolder(false);
        const r = await apiUpload(filename, mime, new Blob([content], { type: mime }), folder.id);
        if (r && r.webViewLink) note.driveLink = r.webViewLink;
        okParts.push('Drive API(' + folder.name + ')');
      } catch (e) { errParts.push('Drive API: ' + (e.message || e)); }
    }

    /* 오디오 함께 저장 (옵션) */
    if (withAudio && note.audioBlob instanceof Blob) {
      const at = note.audioBlob.type || 'audio/webm';
      const audioExt = at.includes('wav') ? 'wav' : at.includes('mp4') ? 'm4a' : at.includes('mpeg') ? 'mp3' : 'webm';
      const audioName = filename.replace(/\.[^.]+$/, '') + '.' + audioExt;
      if (useDir) {
        try { await writeToFolder(audioName, note.audioBlob, !firstSave); okParts.push('오디오(폴더)'); }
        catch (e) { errParts.push('오디오 폴더: ' + (e.message || e)); }
      }
      if (useHook) {
        if (note.audioBlob.size * 4 / 3 > MAX_PAYLOAD) {
          errParts.push('오디오 웹훅: 18MB 초과로 건너뜀');
        } else {
          try {
            const ab64 = await VN.util.blobToBase64(note.audioBlob);
            await sendWebhook(audioName, at, ab64);
            okParts.push('오디오(웹훅)');
          } catch (e) { errParts.push(e.tooBig ? '오디오 웹훅: 18MB 초과로 건너뜀' : '오디오 웹훅 실패: ' + (e.message || e)); }
        }
      }
      if (useApi) {
        // Drive API는 용량 제한을 두지 않는다.
        try {
          const folder = await resolveFolder(false);
          await apiUpload(audioName, at, note.audioBlob, folder.id);
          okParts.push('오디오(Drive API)');
        } catch (e) { errParts.push('오디오 Drive API: ' + (e.message || e)); }
      }
    }

    note.driveFilename = filename;
    await VN.db.saveNote(note);
    const message = (okParts.length ? '저장 완료: ' + okParts.join(', ') : '') +
      (errParts.length ? (okParts.length ? ' / ' : '') + errParts.join(' / ') : '');
    await setLastResult(okParts.length > 0 && !errParts.length, message || '저장할 경로가 없습니다.');
    return { saved: okParts.length > 0, filename, message, titleChanged: firstSave };
  }

  /* 자동 저장 진입점: 설정 꺼짐/경로 없음이면 조용히 스킵 */
  async function autoSave(note) {
    const enabled = await VN.db.getSetting('driveAutoSave', true);
    if (!enabled) return { saved: false, skipped: true };
    const target = await getTarget();
    if (target === 'none') return { saved: false, skipped: true };
    if (target === 'folder') {
      const dirStatus = await getFolderStatus();
      if (!dirStatus.ready) {
        if (dirStatus.name && dirStatus.permission === 'prompt') {
          return { saved: false, message: 'Drive 폴더 재승인이 필요해 자동 저장을 건너뛰었습니다.' };
        }
        return { saved: false, skipped: true };
      }
    }
    if (target === 'webhook') {
      const hookUrl = await VN.db.getSetting('appsScriptUrl', '');
      const hookToken = await VN.db.getSetting('appsScriptToken', '');
      if (!(hookUrl && hookToken)) return { saved: false, skipped: true };
    }
    if (target === 'api') {
      const api = await getApiStatus();
      if (!api.signedIn) {
        return api.configured
          ? { saved: false, message: 'Google 로그인이 만료되어 자동 저장을 건너뛰었습니다. (설정에서 재로그인)' }
          : { saved: false, skipped: true };
      }
    }
    return saveNoteToDrive(note);
  }

  return {
    fsSupported, MAX_PAYLOAD, FOLDER_NAME,
    pickFolder, clearFolder, getFolderStatus, requestFolderPermission, writeToFolder,
    buildWebhookPayload, sendWebhook, enqueueRetry, flushRetryQueue,
    buildMultipartBody, resolveFolder, apiFindFile, apiUpload, getApiStatus,   // Drive API 경로
    getTarget, setTarget, calendarTopic,
    sanitizeFilename, makeFilename, localTopic, generateTopic,
    saveNoteToDrive, autoSave, getLastResult
  };
})();
