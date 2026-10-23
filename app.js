import { normalizeSource, detectFormat, isKnownLiveFLV, readSource, createPlayerLink, sourceLabel } from './player-utils.js';
import { qualityChoices, screenshotFilename, initFrameCapture, captureFrame } from './player-tools.js';
import { initPlayerControls } from './player-controls.js';
import { LiveMP4Player } from './live-mp4.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const controls = initPlayerControls($('player'), video);
initFrameCapture(video);
const exampleURL = new URL('assets/example.flv', document.baseURI).href;
let engine = null;
let source = null;
let generation = 0;
let readinessTimer;
let copyTimer;
let failed = false;
let hlsEngine = null;
let capturePending = false;
let captureBlocked = false;
let qualityMode = 'loading';
let liveOptionURL = null;
let liveOptionAuto = false;

function singleQuality(label, hint) {
  $('quality-select').replaceChildren(new Option(label, '-1'));
  $('quality-select').disabled = true;
  $('quality-hint').textContent = hint;
  $('quality-select').parentElement.title = hint;
}

function resetVideoTools() {
  hlsEngine = null;
  qualityMode = 'loading';
  capturePending = false;
  captureBlocked = false;
  singleQuality('Loading…', 'Available qualities appear after loading.');
  $('screenshot-button').disabled = true;
  $('screenshot-label').textContent = 'Save screenshot';
  $('screenshot-feedback').hidden = true;
}

function refreshQuality() {
  if (failed || !source) return;
  if (qualityMode === 'native') {
    singleQuality('Auto (browser)', 'Your browser manages quality for this stream.');
  } else if (qualityMode === 'flv' || qualityMode === 'mp4') {
    singleQuality(video.videoHeight ? `Original · ${video.videoHeight}p` : 'Original', 'This source provides one quality.');
  } else if (hlsEngine?.levels.length) {
    const choices = qualityChoices(hlsEngine.levels, video.videoHeight);
    if (choices.length === 1) {
      singleQuality(choices[0].label, 'This playlist provides one quality. Use a master playlist for more choices.');
    } else {
      const selected = hlsEngine.manualLevel;
      $('quality-select').replaceChildren(new Option('Auto', '-1'), ...choices.map(({ label, index }) => new Option(label, String(index))));
      $('quality-select').value = String(selected);
      $('quality-select').disabled = false;
      const active = choices.find(({ index }) => index === hlsEngine.currentLevel);
      $('quality-hint').textContent = selected === -1
        ? `Auto adjusts to your connection${active ? ` · ${active.label}` : ''}.`
        : `Selected ${choices.find(({ index }) => index === selected)?.label || 'quality'}.`;
      $('quality-select').parentElement.title = $('quality-hint').textContent;
    }
  }
}

function refreshScreenshot() {
  $('screenshot-button').disabled = !source || failed || capturePending || captureBlocked || video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking;
}

function status(text, state = 'ready') {
  $('player-status').textContent = text;
  $('status-dot').dataset.state = state;
}

function dispose() {
  clearTimeout(readinessTimer);
  controls.setSource();
  const previous = engine;
  engine = null;
  hlsEngine = null;
  if (previous) previous.destroy();
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function fail(title, message) {
  if (failed) return;
  failed = true;
  dispose();
  $('video-message-title').textContent = title;
  $('video-message-text').textContent = message;
  $('video-message').hidden = false;
  status('Unable to play this source', 'error');
  singleQuality('Unavailable', 'Load a playable video to see its quality.');
  refreshScreenshot();
}

function updateAddress() {
  if (!source) return;
  const href = createPlayerLink(location.href, source);
  // Static hosts still receive index.html; query parameters are browser state.
  try { history.replaceState(null, '', href); } catch { /* Player also works in restricted embeds. */ }
}

function loadSource(raw, selected, live, { updateURL = true, example = false } = {}) {
  $('form-error').hidden = true;
  $('video-url').removeAttribute('aria-invalid');
  let url, type;
  try {
    url = normalizeSource(raw, document.baseURI);
    type = detectFormat(url, selected);
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    $('video-url').setAttribute('aria-invalid', 'true');
    $('video-url').focus();
    return;
  }

  generation++;
  const current = generation;
  source = null;
  dispose();
  resetVideoTools();
  failed = false;
  source = { url, type, live: ['flv', 'mp4'].includes(type) && live };
  liveOptionURL = url;
  liveOptionAuto = source.live && isKnownLiveFLV(url, type);
  controls.setSource({
    live: source.live,
    bufferedOnly: source.live,
    getLivePosition: () => hlsEngine?.liveSyncPosition,
    restartLive: type === 'flv' || type === 'hls' ? () => {
      if (current !== generation || failed) return;
      loadSource(url, type, live);
      // Reopening a live FLV connection discards an unrecoverable seek and
      // resumes from the stream currently being published.
      video.play().catch(() => {});
    } : null,
  });
  $('video-url').value = url;
  $('source-type').value = selected === 'auto' ? 'auto' : type;
  $('live-stream').disabled = type === 'hls';
  $('live-stream').checked = source.live;
  $('source-name').textContent = example || url === exampleURL ? 'Example video' : sourceLabel(url);
  $('source-name').title = new URL(url).hostname;
  $('format-badge').textContent = `${type === 'hls' ? 'HLS' : type.toUpperCase()}${source.live ? ' · LIVE' : ''}`;
  $('copy-link').disabled = false;
  clearTimeout(copyTimer);
  $('copy-label').textContent = 'Copy player link';
  $('share-fallback').hidden = true;
  $('video-message').hidden = true;
  if (url === exampleURL) video.setAttribute('poster', 'assets/example-poster.jpg');
  else video.removeAttribute('poster');
  status('Loading video…', 'loading');
  if (updateURL) updateAddress();
  readinessTimer = setTimeout(() => {
    // Native HLS browsers may fetch only metadata until the viewer presses Play.
    if (current === generation && video.readyState < 1) fail('The source is taking too long', 'Check that the URL is still available and the video host allows CORS. Then try loading it again.');
  }, 30000);

  try {
    if (type === 'flv') {
      qualityMode = 'flv';
      refreshQuality();
      if (!window.mpegts) throw new Error('The FLV library could not load. Check that the vendor files were deployed.');
      if (!mpegts.isSupported()) throw new Error('FLV playback needs Media Source Extensions. Try a recent Chrome, Edge, Firefox, or Safari browser.');
      mpegts.LoggingControl.enableAll = false;
      engine = mpegts.createPlayer({ type: 'flv', url, isLive: source.live, cors: true }, {
        enableWorker: true,
        enableStashBuffer: !source.live,
        autoCleanupSourceBuffer: true,
        // Keep roughly 4–6 minutes of live FLV history between cleanups.
        ...(source.live ? {
          autoCleanupMinBackwardDuration: 240,
          autoCleanupMaxBackwardDuration: 360,
        } : {}),
      });
      engine.on(mpegts.Events.ERROR, (kind) => {
        if (current !== generation) return;
        if (kind === mpegts.ErrorTypes.NETWORK_ERROR) networkFailure();
        else fail('This video could not be decoded', 'The FLV file may be invalid or its codec may not be supported by this browser. Try an H.264 video with AAC audio.');
      });
      engine.attachMediaElement(video);
      engine.load();
    } else if (type === 'mp4') {
      qualityMode = 'mp4';
      refreshQuality();
      if (source.live) {
        engine = new LiveMP4Player(video, url, (error) => {
          if (current !== generation || failed) return;
          if (error.network) networkFailure('live MP4 stream', error.status);
          else fail('Live MP4 playback is unavailable', error.message);
        });
        engine.load();
      } else {
        video.crossOrigin = 'anonymous';
        video.src = url;
        video.load();
      }
    } else if (window.Hls && Hls.isSupported()) {
      // A native "maybe" response does not guarantee reliable HLS playback.
      // Prefer the bundled engine, with native HLS for browsers without MSE.
      engine = new Hls({ enableWorker: true });
      hlsEngine = engine;
      qualityMode = 'hls';
      engine.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (current === generation && !failed) controls.setLive(data.details.live);
      });
      for (const event of [Hls.Events.MANIFEST_PARSED, Hls.Events.LEVELS_UPDATED, Hls.Events.LEVEL_SWITCHED]) {
        engine.on(event, () => { if (current === generation && !failed) refreshQuality(); });
      }
      engine.on(Hls.Events.ERROR, (_event, data) => {
        if (current !== generation || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const resource = data.details?.startsWith('manifest') ? 'playlist'
            : data.details?.startsWith('level') ? 'variant playlist'
            : data.details?.startsWith('key') ? 'encryption key' : 'video segment';
          networkFailure(resource, data.response?.code);
        }
        else fail('This stream could not be decoded', 'The playlist or a video segment is invalid, or its codec is not supported by this browser.');
      });
      engine.attachMedia(video);
      engine.loadSource(url);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      qualityMode = 'native';
      refreshQuality();
      // Native video must be CORS-enabled for canvas screenshots as well.
      video.crossOrigin = 'anonymous';
      video.src = url;
      video.load();
    } else {
      if (!window.Hls) throw new Error('The HLS library could not load. Check that the vendor files were deployed.');
      throw new Error('HLS playback is not supported in this browser. Try a recent Chrome, Edge, Firefox, or Safari browser.');
    }
  } catch (error) {
    fail('Playback is unavailable', error.message);
  }
}

function networkFailure(resource = 'video', code) {
  const httpStatus = Number(code);
  let message = `Could not load the ${resource}. `;
  if (httpStatus === 401 || httpStatus === 403) {
    message += `The video host denied access (HTTP ${httpStatus}). Get a fresh playback URL and check the host’s access requirements.`;
  } else if (httpStatus === 404 || httpStatus === 410) {
    message += `The host could not find it (HTTP ${httpStatus}). Check the URL or try a fresh live playlist.`;
  } else {
    if (httpStatus >= 400 && httpStatus <= 599) message += `The host returned HTTP ${httpStatus}. `;
    message += 'Check your connection and the host’s CORS settings for playlists, segments, and keys. A link that works locally (e.g.: VLC) can still be blocked by your browser access rules.';
  }
  fail('We couldn’t load this link', message);
}

video.addEventListener('loadedmetadata', () => {
  if (!source || failed) return;
  clearTimeout(readinessTimer);
  if (video.paused) status('Ready to play · Press play to start');
  refreshQuality();
  if (qualityMode === 'native') controls.setLive(video.duration === Infinity);
});
video.addEventListener('durationchange', () => {
  if (qualityMode === 'native' && source && !failed) controls.setLive(video.duration === Infinity);
});
video.addEventListener('canplay', () => {
  if (!source || failed) return;
  clearTimeout(readinessTimer);
  status(video.paused ? 'Ready to play · Press play to start' : 'Playing');
  refreshScreenshot();
});
for (const event of ['loadeddata', 'seeked', 'resize', 'playing']) {
  video.addEventListener(event, () => { refreshQuality(); refreshScreenshot(); });
}
for (const event of ['seeking', 'emptied']) {
  video.addEventListener(event, refreshScreenshot);
}
video.addEventListener('playing', () => { if (!failed) status('Playing'); });
video.addEventListener('pause', () => { if (source && !failed && video.readyState >= 2) status(video.ended ? 'Playback finished' : 'Paused · Press play to resume'); });
video.addEventListener('waiting', () => { if (source && !failed) status('Buffering…', 'loading'); });
video.addEventListener('ended', () => { if (!failed) status('Playback finished · Press play to replay'); });
video.addEventListener('error', () => {
  if (!source || failed || !video.error) return;
  if (video.error.code === MediaError.MEDIA_ERR_NETWORK) networkFailure();
  else fail('This source could not be played', 'Check that this is a direct video or playlist URL and that its codec is supported by your browser.');
});

$('source-form').addEventListener('submit', (event) => {
  event.preventDefault();
  loadSource($('video-url').value, $('source-type').value, $('live-stream').checked);
});
$('quality-select').addEventListener('change', () => {
  if (!hlsEngine || failed) return;
  const level = Number($('quality-select').value);
  if (!Number.isInteger(level) || level < -1 || level >= hlsEngine.levels.length) return;
  // HLS.js preserves playback position while flushing for the chosen rendition.
  hlsEngine.currentLevel = level;
  refreshQuality();
});
$('screenshot-button').addEventListener('click', async () => {
  if ($('screenshot-button').disabled || !source) return;
  const current = generation;
  const filename = screenshotFilename(source.url, video.currentTime);
  capturePending = true;
  $('screenshot-label').textContent = 'Saving…';
  $('screenshot-feedback').hidden = true;
  refreshScreenshot();
  try {
    const blob = await captureFrame(video);
    // An old capture must not affect a newly selected video or failed source.
    if (current !== generation || failed) return;
    const objectURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectURL;
    link.download = filename;
    document.body.append(link);
    try { link.click(); }
    finally {
      link.remove();
      // Keep the URL alive long enough for download handling in Safari/Firefox.
      setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
    }
    $('screenshot-feedback').textContent = `Screenshot ready · ${filename}`;
    $('screenshot-feedback').dataset.state = 'success';
    $('screenshot-feedback').hidden = false;
  } catch (error) {
    if (current !== generation || failed) return;
    if (error.name === 'SecurityError') {
      captureBlocked = true;
      $('screenshot-feedback').textContent = 'This video host does not allow screenshots from this page. Its media responses must permit cross-origin access (CORS).';
    } else {
      $('screenshot-feedback').textContent = error.message || 'Could not save the screenshot. Please try again.';
    }
    $('screenshot-feedback').dataset.state = 'error';
    $('screenshot-feedback').hidden = false;
  } finally {
    if (current === generation) {
      capturePending = false;
      $('screenshot-label').textContent = 'Save screenshot';
      refreshScreenshot();
      controls.reveal();
    }
  }
});
function refreshLiveOption() {
  let type = $('source-type').value;
  let url;
  try {
    url = new URL($('video-url').value, document.baseURI).href;
    type = detectFormat(url, type);
  }
  catch { /* Unknown URLs retain the selected format until they are loaded. */ }
  if (url !== liveOptionURL) {
    const detected = isKnownLiveFLV(url, type);
    if (detected || liveOptionAuto) $('live-stream').checked = detected;
    liveOptionAuto = detected;
    liveOptionURL = url;
  }
  $('live-stream').disabled = type === 'hls';
}
$('source-type').addEventListener('change', refreshLiveOption);
$('video-url').addEventListener('input', refreshLiveOption);
$('live-stream').addEventListener('change', () => { liveOptionAuto = false; });
$('retry-button').addEventListener('click', () => {
  if (source) loadSource(source.url, source.type, source.live);
});
$('example-button').addEventListener('click', () => {
  $('source-type').value = 'auto';
  $('live-stream').checked = false;
  $('live-stream').disabled = false;
  loadSource(exampleURL, 'flv', false, { example: true });
});
$('copy-link').addEventListener('click', async () => {
  if (!source) return;
  const link = createPlayerLink(location.href, source);
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(link);
    $('copy-label').textContent = 'Link copied!';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('copy-label').textContent = 'Copy player link'; }, 2500);
  } catch {
    $('share-fallback').hidden = false;
    $('share-url').value = link;
    $('share-url').focus();
    $('share-url').select();
  }
});
$('close-share').addEventListener('click', () => {
  $('share-fallback').hidden = true;
  $('copy-link').focus();
});

function restoreLocation() {
  const initial = readSource(location.search);
  $('video-url').value = initial.url;
  $('source-type').value = initial.type;
  $('live-stream').checked = initial.live;
  $('live-stream').disabled = initial.type === 'hls';
  if (initial.url) loadSource(initial.url, initial.type, initial.live, { updateURL: false });
  else loadSource(exampleURL, 'flv', false, { updateURL: false, example: true });
}
window.addEventListener('popstate', restoreLocation);
restoreLocation();
