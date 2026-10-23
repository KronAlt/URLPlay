export function formatTime(seconds) {
  const total = Math.floor(Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60);
  return `${hours ? `${hours}:${minutes.padStart(2, '0')}` : minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function seekWindow(video, { bufferedOnly = false } = {}) {
  // MSE seekable can include history that a live source can no longer fetch.
  const ranges = bufferedOnly ? video.buffered : video.seekable;
  if (ranges?.length) return { start: ranges.start(0), end: ranges.end(ranges.length - 1) };
  return { start: 0, end: !bufferedOnly && Number.isFinite(video.duration) ? Math.max(0, video.duration) : 0 };
}

export function seekTarget(video, time, { bufferedOnly = false } = {}) {
  if (!Number.isFinite(time)) return null;
  const ranges = bufferedOnly ? video.buffered : video.seekable;
  let nearest = null;
  for (let i = 0; i < (ranges?.length || 0); i++) {
    // Stay inside the range: its exact end has no frame to decode, and cleanup
    // can leave the beginning just before the first usable sample.
    const inset = bufferedOnly ? Math.min(0.1, (ranges.end(i) - ranges.start(i)) / 4) : 0;
    const start = ranges.start(i) + inset;
    const end = ranges.end(i) - inset;
    if (end <= start) continue;
    const target = Math.max(start, Math.min(end, time));
    if (nearest === null || Math.abs(target - time) < Math.abs(nearest - time)) nearest = target;
  }
  if (nearest !== null || bufferedOnly) return nearest;
  const { start, end } = seekWindow(video);
  return end > start ? Math.max(start, Math.min(end, time)) : null;
}

export function initPlayerControls(player, video) {
  const $ = (id) => player.querySelector(`#${id}`);
  const controls = $('player-controls');
  const play = $('play-toggle');
  const centerPlay = $('center-play');
  const seek = $('seek-control');
  const mute = $('mute-toggle');
  const volume = $('volume-control');
  const liveButton = $('live-toggle');
  const fullscreen = $('fullscreen-toggle');
  let hideTimer;
  let scrubbing = false;
  let overControls = false;
  let pointerType = 'mouse';
  let fullscreenBusy = false;
  let previousOverflow = '';
  let hasStarted = false;
  let live = false;
  let bufferedOnly = false;
  let getLivePosition;
  let restartLive;
  let recoveryTimer;
  let seekPending = false;
  let recoveryAttempted = false;

  function clearRecovery() {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    seekPending = false;
    recoveryAttempted = false;
  }

  function liveTarget() {
    const { start, end } = seekWindow(video, { bufferedOnly });
    if (end <= start) return null;
    const suggested = getLivePosition?.();
    const time = Number.isFinite(suggested) && suggested >= start && suggested < end
      ? suggested : Math.max(start, end - Math.min(1, (end - start) / 2));
    return seekTarget(video, time, { bufferedOnly });
  }

  function watchLiveSeek() {
    if (!live || !seekPending || video.paused || recoveryTimer) return;
    const position = video.currentTime;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!live || video.paused || !seekPending) return;
      if (!video.seeking && video.readyState >= 3 && video.currentTime > position + 0.25) {
        clearRecovery();
        return;
      }
      if (recoveryAttempted) {
        clearRecovery();
        restartLive?.();
        return;
      }
      recoveryAttempted = true;
      goLive(false);
    }, 5000);
  }

  function goLive(manual = true) {
    if (!live) return;
    if (manual) clearRecovery();
    const target = liveTarget();
    if (target === null) {
      restartLive?.();
      return;
    }
    seekPending = true;
    video.currentTime = target;
    if (video.paused) video.play().catch(() => playback());
    watchLiveSeek();
    progress();
    reveal();
  }

  function reveal() {
    clearTimeout(hideTimer);
    player.classList.remove('controls-idle');
    hideTimer = setTimeout(() => {
      const focused = document.activeElement;
      if (video.paused || video.ended || video.seeking || video.readyState < 3 || seekPending || scrubbing || overControls ||
          (controls.contains(focused) && focused.matches(':focus-visible'))) return;
      player.classList.add('controls-idle');
    }, 3000);
  }

  function progress() {
    const { start, end } = seekWindow(video, { bufferedOnly });
    seek.min = String(start);
    seek.max = String(end);
    seek.disabled = end <= start;
    if (!scrubbing) seek.value = String(Math.max(start, Math.min(end, video.currentTime || 0)));
    const time = formatTime(video.currentTime);
    const duration = live || video.duration === Infinity ? 'Live' : formatTime(video.duration);
    $('time-display').textContent = `${time} / ${duration}`;
    seek.setAttribute('aria-valuetext', `${time} of ${duration}`);
    liveButton.hidden = !live;
    const target = live ? liveTarget() : null;
    liveButton.disabled = !live || (target === null && !restartLive);
    liveButton.dataset.atLive = String(live && target !== null && Math.abs(target - video.currentTime) <= 2 && !video.paused);
  }

  function playback() {
    const paused = video.paused || video.ended;
    $('play-icon').toggleAttribute('hidden', !paused);
    $('pause-icon').toggleAttribute('hidden', paused);
    play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    play.title = `${paused ? 'Play' : 'Pause'} (Space / K)`;
    play.disabled = !video.currentSrc && !video.getAttribute('src');
    centerPlay.hidden = hasStarted || !paused || play.disabled || video.readyState < 1 || !!video.error;
    progress();
  }

  function sound() {
    const silent = video.muted || video.volume === 0;
    $('sound-icon').toggleAttribute('hidden', silent);
    $('muted-icon').toggleAttribute('hidden', !silent);
    mute.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    mute.setAttribute('aria-pressed', String(silent));
    mute.title = `${silent ? 'Unmute' : 'Mute'} (M)`;
    volume.value = String(video.muted ? 0 : video.volume);
    volume.setAttribute('aria-valuetext', `${Math.round(Number(volume.value) * 100)}%`);
  }

  async function togglePlayback() {
    reveal();
    if (!video.paused && !video.ended) video.pause();
    else {
      try { await video.play(); }
      catch { playback(); } // Media errors are reported by the main player.
    }
  }

  const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  function syncFullscreen() {
    const active = fullscreenElement() === player || player.classList.contains('fullscreen-fallback');
    player.classList.toggle('is-fullscreen', active);
    fullscreen.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    fullscreen.setAttribute('aria-pressed', String(active));
    fullscreen.title = `${active ? 'Exit fullscreen' : 'Fullscreen'} (F)`;
    $('enter-fullscreen-icon').toggleAttribute('hidden', active);
    $('exit-fullscreen-icon').toggleAttribute('hidden', !active);
    reveal();
  }

  function windowFullscreen(active) {
    if (active) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    } else document.body.style.overflow = previousOverflow;
    player.classList.toggle('fullscreen-fallback', active);
    syncFullscreen();
  }

  async function toggleFullscreen() {
    if (fullscreenBusy) return;
    fullscreenBusy = true;
    try {
      if (player.classList.contains('fullscreen-fallback')) windowFullscreen(false);
      else if (fullscreenElement() === player) {
        await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        const request = player.requestFullscreen || player.webkitRequestFullscreen;
        if (request) {
          try { await request.call(player); }
          catch { windowFullscreen(true); }
        } else windowFullscreen(true);
      }
    } finally {
      fullscreenBusy = false;
      syncFullscreen();
    }
  }

  function seekBy(seconds) {
    seekTo(video.currentTime + seconds);
  }

  function seekTo(time) {
    const target = seekTarget(video, time, { bufferedOnly });
    if (target === null) return;
    clearRecovery();
    seekPending = live;
    video.currentTime = target;
    watchLiveSeek();
  }

  function guardLiveSeek() {
    if (!live) return;
    if (bufferedOnly) {
      const target = seekTarget(video, video.currentTime, { bufferedOnly });
      if (target !== null && Math.abs(target - video.currentTime) > 0.01) video.currentTime = target;
    } else {
      const { start, end } = seekWindow(video);
      if (end > start && video.currentTime < start) {
        const target = liveTarget();
        if (target !== null) video.currentTime = target;
      }
    }
    seekPending = true;
    watchLiveSeek();
  }

  play.addEventListener('click', togglePlayback);
  centerPlay.addEventListener('click', () => {
    player.focus({ preventScroll: true });
    togglePlayback();
  });
  mute.addEventListener('click', () => { video.muted = !(video.muted || video.volume === 0); if (!video.muted && video.volume === 0) video.volume = 1; });
  volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; });
  liveButton.addEventListener('click', () => goLive());
  seek.addEventListener('pointerdown', () => { scrubbing = true; });
  function finishScrubbing() {
    if (!scrubbing) return;
    scrubbing = false;
    progress();
    reveal();
  }
  for (const event of ['pointerup', 'pointercancel', 'change']) seek.addEventListener(event, finishScrubbing);
  for (const event of ['pointerup', 'pointercancel']) document.addEventListener(event, finishScrubbing);
  seek.addEventListener('blur', finishScrubbing);
  seek.addEventListener('input', () => {
    seekTo(Number(seek.value));
    progress();
    reveal();
  });
  fullscreen.addEventListener('click', toggleFullscreen);
  player.addEventListener('pointermove', reveal);
  player.addEventListener('pointerdown', (event) => { pointerType = event.pointerType; reveal(); });
  controls.addEventListener('pointerenter', () => { overControls = true; reveal(); });
  controls.addEventListener('pointerleave', () => { overControls = false; reveal(); });
  player.addEventListener('focusin', reveal);
  player.addEventListener('focusout', reveal);
  video.addEventListener('click', () => {
    player.focus({ preventScroll: true });
    if (pointerType !== 'touch') togglePlayback();
    else reveal();
  });
  player.addEventListener('keydown', (event) => {
    reveal();
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('button,input,select,a')) return;
    const key = event.key.toLowerCase();
    if (![' ', 'k', 'm', 'f', 'arrowleft', 'arrowright'].includes(key)) return;
    event.preventDefault();
    if (key === ' ' || key === 'k') togglePlayback();
    else if (key === 'm') video.muted = !video.muted;
    else if (key === 'f') toggleFullscreen();
    else seekBy(key === 'arrowleft' ? -5 : 5);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && player.classList.contains('fullscreen-fallback')) {
      windowFullscreen(false);
      fullscreen.focus({ preventScroll: true });
    }
  });
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  video.addEventListener('playing', () => { hasStarted = true; clearRecovery(); });
  video.addEventListener('emptied', () => { hasStarted = false; scrubbing = false; clearRecovery(); });
  video.addEventListener('seeking', guardLiveSeek);
  video.addEventListener('play', watchLiveSeek);
  video.addEventListener('waiting', () => {
    if (!live || !hasStarted || video.paused) return;
    reveal();
    const { start, end } = seekWindow(video, { bufferedOnly });
    // An expired paused position or a hole between retained ranges cannot be
    // downloaded again from a live FLV/MP4 stream.
    const target = seekTarget(video, video.currentTime, { bufferedOnly });
    if ((end > start && video.currentTime < start) ||
        (bufferedOnly && target !== null && Math.abs(target - video.currentTime) > 0.01 && video.currentTime < end - 1)) {
      goLive();
    } else watchLiveSeek();
  });
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'seeking', 'seeked', 'emptied']) video.addEventListener(event, progress);
  for (const event of ['loadedmetadata', 'play', 'pause', 'playing', 'ended', 'emptied', 'loadstart', 'canplay', 'error']) {
    video.addEventListener(event, () => { playback(); reveal(); });
  }
  video.addEventListener('volumechange', sound);
  playback();
  sound();
  video.controls = false;
  controls.hidden = false;
  player.classList.add('controls-enhanced');
  return {
    reveal,
    setSource(options = {}) {
      clearRecovery();
      scrubbing = false;
      live = !!options.live;
      bufferedOnly = !!options.bufferedOnly;
      getLivePosition = options.getLivePosition;
      restartLive = options.restartLive;
      progress();
    },
    setLive(value) {
      live = !!value;
      if (!live) clearRecovery();
      progress();
    },
  };
}
