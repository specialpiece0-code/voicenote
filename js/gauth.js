/* VN.gauth — Google Identity Services 토큰 클라이언트 (Drive API + Calendar 읽기)
   · GIS 스크립트는 실제 로그인/토큰 요청 시점에만 lazy load
   · 클라이언트 ID는 사용자가 설정에 붙여넣어 IndexedDB(googleClientId)에 저장
   · 액세스 토큰 + 만료시각(발급 + expires_in − 60초)을 설정(googleToken)에 저장
   · 만료 시 prompt:'' 로 조용히 재발급, 실패하면 null → 호출부가 재로그인 안내 */
window.VN = window.VN || {};

VN.gauth = (function () {
  const SCOPE = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar.readonly';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const REQ_TIMEOUT = 30000;

  let gisPromise = null;      // GIS 스크립트 로드 1회
  let tokenClient = null;     // initTokenClient 결과
  let tokenClientId = null;   // tokenClient가 만들어진 client_id
  let inflight = null;        // 동시 재발급 방지

  /* ══════════ 순수 함수 (셀프테스트 대상) ══════════ */

  /* 발급시각 + (expires_in − 60초). 잘못된 값이면 0(=즉시 만료) */
  function computeExpiry(issuedAt, expiresIn) {
    const n = Number(expiresIn);
    if (!isFinite(n) || n <= 0) return 0;
    return issuedAt + Math.max(0, n - 60) * 1000;
  }

  /* 토큰이 지금 쓸 수 있는지 */
  function isTokenValid(tok, now) {
    if (!tok || !tok.accessToken || !tok.expiresAt) return false;
    return (now == null ? Date.now() : now) < tok.expiresAt;
  }

  /* ══════════ GIS 로드 ══════════ */

  function gisReady() {
    return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
  }

  function loadGis() {
    if (gisReady()) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => {
        if (gisReady()) res();
        else { gisPromise = null; rej(new Error('Google Identity Services를 초기화하지 못했습니다.')); }
      };
      s.onerror = () => { gisPromise = null; rej(new Error('Google 로그인 스크립트를 불러오지 못했습니다. (네트워크 확인)')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  /* ══════════ 설정 입출력 ══════════ */

  async function getClientId() {
    const v = await VN.db.getSetting('googleClientId', '');
    return String(v || '').trim();
  }
  async function setClientId(id) {
    await VN.db.setSetting('googleClientId', String(id || '').trim());
    tokenClient = null; tokenClientId = null;   // 클라이언트 재생성 강제
  }
  async function isConfigured() { return !!(await getClientId()); }

  async function getStoredToken() { return VN.db.getSetting('googleToken', null); }
  async function storeToken(tok) { await VN.db.setSetting('googleToken', tok); }

  /* 토큰만 폐기(재로그인 없이 다음 호출에서 조용히 재발급 시도) */
  async function invalidate() {
    await VN.db.setSetting('googleToken', null);
  }

  /* ══════════ 토큰 요청 ══════════ */

  function ensureClient(clientId) {
    if (tokenClient && tokenClientId === clientId) return tokenClient;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => { /* requestToken에서 매번 교체 */ }
    });
    tokenClientId = clientId;
    return tokenClient;
  }

  /* prompt: 'consent'(명시적 로그인) | ''(조용한 재발급) */
  function requestToken(clientId, prompt) {
    return new Promise((res, rej) => {
      const client = ensureClient(clientId);
      let done = false;
      const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
      const timer = setTimeout(() => finish(rej, new Error('Google 로그인 응답 시간이 초과되었습니다.')), REQ_TIMEOUT);
      client.callback = (resp) => {
        if (!resp || resp.error) finish(rej, new Error((resp && (resp.error_description || resp.error)) || '토큰 발급에 실패했습니다.'));
        else finish(res, resp);
      };
      client.error_callback = (err) => finish(rej, new Error((err && (err.message || err.type)) || '로그인이 취소되었습니다.'));
      try { client.requestAccessToken({ prompt: prompt }); }
      catch (e) { finish(rej, e instanceof Error ? e : new Error(String(e))); }
    });
  }

  async function saveFromResponse(resp) {
    const tok = {
      accessToken: resp.access_token,
      expiresAt: computeExpiry(Date.now(), resp.expires_in),
      scope: resp.scope || SCOPE
    };
    await storeToken(tok);
    return tok.accessToken;
  }

  /* 유효하면 그대로, 만료면 조용히 재발급, 실패하면 null */
  async function getToken() {
    const clientId = await getClientId();
    if (!clientId) return null;
    const tok = await getStoredToken();
    if (isTokenValid(tok, Date.now())) return tok.accessToken;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await loadGis();
        const resp = await requestToken(clientId, '');
        return await saveFromResponse(resp);
      } catch (e) {
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /* 명시적 로그인(사용자 제스처에서만 호출) */
  async function signIn() {
    const clientId = await getClientId();
    if (!clientId) throw new Error('Google 클라이언트 ID가 설정되지 않았습니다.');
    await loadGis();
    const resp = await requestToken(clientId, 'consent');
    const token = await saveFromResponse(resp);
    await fetchEmail(token);   // 실패해도 무시
    return true;
  }

  async function signOut() {
    const tok = await getStoredToken();
    try {
      if (tok && tok.accessToken && gisReady() && window.google.accounts.oauth2.revoke) {
        window.google.accounts.oauth2.revoke(tok.accessToken, () => { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
    await VN.db.setSetting('googleToken', null);
    await VN.db.setSetting('googleEmail', '');
  }

  /* 로그인 직후 1회 — 실패해도 조용히 무시 */
  async function fetchEmail(token) {
    try {
      const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!resp.ok) return '';
      const j = await resp.json();
      const email = j.email || '';
      if (email) await VN.db.setSetting('googleEmail', email);
      return email;
    } catch (e) { return ''; }
  }

  async function status() {
    const [clientId, tok, email] = await Promise.all([
      getClientId(), getStoredToken(), VN.db.getSetting('googleEmail', '')
    ]);
    return {
      configured: !!clientId,
      signedIn: isTokenValid(tok, Date.now()),
      hasToken: !!(tok && tok.accessToken),
      email: email || '',
      expiresAt: (tok && tok.expiresAt) || 0
    };
  }

  /* Authorization 헤더를 붙여 호출. 401이면 invalidate 후 1회만 재시도. */
  async function authFetch(url, opts) {
    const o = Object.assign({}, opts || {});
    let token = await getToken();
    if (!token) throw new Error('Google 로그인이 필요합니다.');
    const call = (t) => {
      const h = Object.assign({}, o.headers || {});
      h.Authorization = 'Bearer ' + t;
      return fetch(url, Object.assign({}, o, { headers: h }));
    };
    let resp = await call(token);
    if (resp.status === 401) {
      await invalidate();
      token = await getToken();
      if (!token) throw new Error('Google 로그인이 만료되었습니다. 설정에서 다시 로그인해 주세요.');
      resp = await call(token);
    }
    return resp;
  }

  return {
    SCOPE,
    computeExpiry, isTokenValid,        // 순수 함수 (셀프테스트용)
    isConfigured, getClientId, setClientId,
    signIn, signOut, getToken, status, invalidate, authFetch
  };
})();
