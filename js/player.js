/* VN.player — 재생 동기화 플레이어
   세그먼트 하이라이트·클릭 시크·배속·A-B 반복·±10초·파형 시크바.
   Chrome MediaRecorder webm Blob의 duration=Infinity 워크어라운드 포함. */
window.VN = window.VN || {};

VN.player = (function () {
  const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

  /* create(audioEl, note, {onTime(sec), onEnded()}) */
  function create(audioEl, note, opts) {
    opts = opts || {};
    let objectUrl = null;
    let duration = note.duration || 0;
    let abA = null, abB = null;
    let speedIdx = 2; // 1.0
    let destroyed = false;
    let waveCanvas = null;

    if (note.audioBlob instanceof Blob) {
      objectUrl = URL.createObjectURL(note.audioBlob);
      audioEl.src = objectUrl;
    }

    /* webm duration=Infinity 워크어라운드:
       loadedmetadata에서 currentTime을 매우 크게 설정 → durationchange 후 되돌림 */
    audioEl.addEventListener('loadedmetadata', function () {
      if (audioEl.duration === Infinity || isNaN(audioEl.duration)) {
        const onDur = function () {
          if (audioEl.duration !== Infinity && !isNaN(audioEl.duration)) {
            audioEl.removeEventListener('durationchange', onDur);
            duration = audioEl.duration;
            audioEl.currentTime = 0;
            drawWave();
          }
        };
        audioEl.addEventListener('durationchange', onDur);
        audioEl.currentTime = 1e7;
      } else {
        duration = audioEl.duration || duration;
        drawWave();
      }
    });

    audioEl.addEventListener('timeupdate', function () {
      if (destroyed) return;
      // A-B 반복
      if (abA != null && abB != null && audioEl.currentTime >= abB) {
        audioEl.currentTime = abA;
      }
      if (opts.onTime) opts.onTime(audioEl.currentTime);
      drawWave();
    });
    audioEl.addEventListener('ended', function () { if (opts.onEnded) opts.onEnded(); });

    function getDuration() {
      const d = audioEl.duration;
      return (d && d !== Infinity && !isNaN(d)) ? d : (duration || 1);
    }

    /* 파형 시크바 — 탭 + 드래그 시크 (pointer capture) */
    function bindWave(canvas) {
      waveCanvas = canvas;
      let dragging = false;
      const seekFromEvent = function (e) {
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        seekTo(ratio * getDuration());
      };
      canvas.addEventListener('pointerdown', function (e) {
        dragging = true;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        seekFromEvent(e);
      });
      canvas.addEventListener('pointermove', function (e) { if (dragging) seekFromEvent(e); });
      const endDrag = function () { dragging = false; };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);
      drawWave();
    }

    function drawWave() {
      if (!waveCanvas) return;
      const ctx = waveCanvas.getContext('2d');
      const W = waveCanvas.width = waveCanvas.clientWidth * (window.devicePixelRatio || 1);
      const H = waveCanvas.height = waveCanvas.clientHeight * (window.devicePixelRatio || 1);
      ctx.clearRect(0, 0, W, H);
      const style = getComputedStyle(document.documentElement);
      const green = style.getPropertyValue('--green').trim() || '#03C75A';
      const gray = style.getPropertyValue('--border').trim() || '#E5E8EB';
      const wf = note.waveform && note.waveform.length ? note.waveform : null;
      const progress = getDuration() ? audioEl.currentTime / getDuration() : 0;
      const bars = 120;
      const bw = W / bars;
      for (let i = 0; i < bars; i++) {
        let amp = 0.35;
        if (wf) {
          const j = Math.floor(i / bars * wf.length);
          amp = Math.max(0.06, Math.min(1, wf[j] || 0.06));
        }
        const bh = amp * (H - 8);
        ctx.fillStyle = (i / bars) <= progress ? green : gray;
        ctx.fillRect(i * bw + bw * 0.2, (H - bh) / 2, bw * 0.6, bh);
      }
      // A-B 마커
      if (abA != null) drawMarker(ctx, abA / getDuration() * W, H, '#F5A623');
      if (abB != null) drawMarker(ctx, abB / getDuration() * W, H, '#E5484D');
    }
    function drawMarker(ctx, x, H, color) {
      ctx.fillStyle = color;
      ctx.fillRect(x - 1, 0, 3, H);
    }

    function play() { return audioEl.play().catch(() => {}); }
    function pause() { audioEl.pause(); }
    function toggle() { if (audioEl.paused) play(); else pause(); }
    function seekTo(sec) {
      audioEl.currentTime = Math.max(0, Math.min(getDuration(), sec));
      drawWave();
    }
    function skip(delta) { seekTo(audioEl.currentTime + delta); }
    function playFrom(sec) { seekTo(sec); return play(); }

    function cycleSpeed() {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      audioEl.playbackRate = SPEEDS[speedIdx];
      return SPEEDS[speedIdx];
    }
    function setSpeed(v) {
      const i = SPEEDS.indexOf(v);
      if (i >= 0) speedIdx = i;
      audioEl.playbackRate = v;
    }

    /* A-B 반복: 1회 → A 설정, 2회 → B 설정, 3회 → 해제 */
    function toggleAB() {
      if (abA == null) { abA = audioEl.currentTime; drawWave(); return 'A';
      } else if (abB == null) {
        abB = audioEl.currentTime;
        if (abB <= abA) { const t = abA; abA = abB; abB = t; }
        drawWave(); return 'B';
      } else { abA = abB = null; drawWave(); return null; }
    }

    /* URL.createObjectURL 누수 방지 — 노트 전환 시 반드시 호출 */
    function destroy() {
      destroyed = true;
      try { audioEl.pause(); } catch (e) { /* ignore */ }
      audioEl.removeAttribute('src');
      try { audioEl.load(); } catch (e) { /* ignore */ }
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    }

    return {
      audioEl, play, pause, toggle, seekTo, skip, playFrom,
      cycleSpeed, setSpeed, toggleAB, bindWave, drawWave, destroy,
      get currentTime() { return audioEl.currentTime; },
      get duration() { return getDuration(); },
      get paused() { return audioEl.paused; },
      get speed() { return audioEl.playbackRate; },
      get abState() { return abA == null ? null : (abB == null ? 'A' : 'AB'); },
      get hasAudio() { return !!objectUrl; }
    };
  }

  return { create, SPEEDS };
})();
