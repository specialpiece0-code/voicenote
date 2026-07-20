/* VN.stt — SpeechRecognition 래퍼
   연속 인식 + 무음/네트워크로 인한 종료 시 자동 재시작 + 타임스탬프 세그먼트.
   타임스탬프는 인식 이벤트 시각(VN.recorder.currentTime, 일시정지 제외)으로 근사한다.
   lastResultAt: 마지막 인식 결과 시각(Date.now) — 백그라운드 중단 감지에 사용. */
window.VN = window.VN || {};

VN.stt = (function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SR;

  let recog = null;
  let active = false;       // 사용자가 인식을 원함(자동 재시작 기준)
  let cb = {};              // {onInterim(text), onFinal({start,end,text}), onError(msg)}
  let segStart = null;      // 현재 발화 시작 시각(근사)
  let restartTimer = null;
  let lastResult = 0;       // 마지막 인식 결과(중간 포함) 시각 Date.now

  function now() {
    try { return VN.recorder.currentTime(); } catch (e) { return 0; }
  }

  function scheduleRestart() {
    if (!active) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!active || !recog) return;
      try { recog.start(); } catch (err) { /* 이미 시작된 경우 무시 */ }
    }, 250);
  }

  function build(lang) {
    const r = new SR();
    r.lang = lang || 'ko-KR';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      lastResult = Date.now();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0] ? res[0].transcript : '';
        if (res.isFinal) {
          const t = text.trim();
          if (t) {
            const end = now();
            const start = segStart != null ? segStart : Math.max(0, end - 2);
            if (cb.onFinal) cb.onFinal({ start, end, text: t });
          }
          segStart = null;
        } else {
          if (segStart == null) segStart = now();
          interim += text;
        }
      }
      if (cb.onInterim) cb.onInterim(interim);
    };
    r.onerror = (e) => {
      // 권한 거부만 종료. no-speech/network/aborted 등은 재시작.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        active = false;
        if (cb.onError) cb.onError('마이크 사용 권한이 없어 음성인식을 중단했습니다.');
        return;
      }
      scheduleRestart(); // onend에서도 재시작하지만 이중 안전
    };
    r.onend = () => {
      if (cb.onInterim) cb.onInterim('');
      // 무음·네트워크로 수시 종료됨 → 녹음 중이면 자동 재시작
      scheduleRestart();
    };
    return r;
  }

  function start(lang, callbacks) {
    if (!supported) return false;
    cb = callbacks || {};
    segStart = null;
    active = true;
    lastResult = Date.now();
    recog = build(lang);
    try { recog.start(); } catch (e) { return false; }
    return true;
  }

  function stop() {
    active = false;
    clearTimeout(restartTimer);
    if (recog) { try { recog.stop(); } catch (e) { /* ignore */ } }
    recog = null;
  }

  /* 일시정지: 인식만 잠시 끔(재개 시 start 재호출) */
  function pause() {
    active = false;
    clearTimeout(restartTimer);
    if (recog) { try { recog.stop(); } catch (e) { /* ignore */ } }
  }
  function resume(lang) {
    if (!supported) return;
    active = true;
    lastResult = Date.now();
    recog = build(lang);
    try { recog.start(); } catch (e) { /* ignore */ }
  }

  return {
    supported, start, stop, pause, resume,
    lastResultAt() { return lastResult; }
  };
})();
