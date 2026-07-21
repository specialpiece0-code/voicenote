/* VN.gcal — Google Calendar(읽기 전용) 연동
   · 녹음 시작 화면: 현재시각 ±30분 일정을 칩으로 제안 → 제목·참석자 미리 채우기
   · 노트 상세: 최근 7일 ~ 앞으로 7일 일정 목록에서 선택해 연결
   · 로그인 안 됐거나 권한이 없으면 조용히 빈 배열 (에러 배너 금지) */
window.VN = window.VN || {};

VN.gcal = (function () {
  const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

  /* ══════════ 순수 함수 (셀프테스트 대상) ══════════ */

  function eventTitle(ev) {
    const t = String((ev && ev.summary) || '').trim();
    return t || '(제목 없음)';
  }

  /* attendees → 표시 이름 배열. displayName 없으면 이메일 로컬파트. 회의실(resource) 제외. */
  function attendeeNames(ev) {
    const list = (ev && Array.isArray(ev.attendees)) ? ev.attendees : [];
    const out = [];
    for (const a of list) {
      if (!a || a.resource) continue;
      let n = String(a.displayName || '').trim();
      if (!n) n = String(a.email || '').split('@')[0].trim();
      if (n && out.indexOf(n) === -1) out.push(n);
    }
    return out;
  }

  /* start.dateTime(시각 지정) 또는 start.date(종일) → ms. 없으면 0 */
  function eventStartMs(ev) {
    const s = (ev && ev.start) || {};
    const raw = s.dateTime || s.date || '';
    const ms = raw ? Date.parse(raw) : NaN;
    return isFinite(ms) ? ms : 0;
  }

  /* 이벤트 → 노트에 저장할 최소 정보 */
  function toNoteCalendar(ev) {
    return { id: (ev && ev.id) || '', title: eventTitle(ev), start: eventStartMs(ev) };
  }

  /* ══════════ API ══════════ */

  /* 로그인 흔적이 없으면 네트워크를 건드리지 않는다 (조용한 숨김용) */
  async function available() {
    try {
      const st = await VN.gauth.status();
      return !!(st.configured && st.hasToken);
    } catch (e) { return false; }
  }

  /* 실패는 전부 빈 배열 — 호출부에서 조용히 숨김 */
  async function listEvents(timeMin, timeMax) {
    if (!(await available())) return [];
    const qs = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50'
    });
    try {
      const resp = await VN.gauth.authFetch(API + '?' + qs.toString(), { method: 'GET' });
      if (!resp.ok) return [];
      const j = await resp.json();
      const items = Array.isArray(j.items) ? j.items : [];
      return items.filter(ev => ev && ev.status !== 'cancelled');
    } catch (e) {
      // 토큰 만료(무음 재발급 실패 포함)는 삼키지 말고 상단 배너로 재로그인 안내
      if (/로그인이 (만료|필요)/.test(String((e && e.message) || '')) &&
        VN.ui && VN.ui.notifyAuthExpired) VN.ui.notifyAuthExpired();
      return [];
    }
  }

  /* 현재시각 ±30분에 걸치는 일정 */
  async function currentEvents() {
    const now = Date.now(), half = 30 * 60 * 1000;
    return listEvents(now - half, now + half);
  }

  /* 최근 7일 ~ 앞으로 7일 */
  async function nearbyEvents() {
    const now = Date.now(), week = 7 * 24 * 60 * 60 * 1000;
    return listEvents(now - week, now + week);
  }

  return {
    eventTitle, attendeeNames, eventStartMs, toNoteCalendar,   // 순수 함수 (셀프테스트용)
    available, listEvents, currentEvents, nearbyEvents
  };
})();
