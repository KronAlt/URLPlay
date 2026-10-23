import { sourceLabel } from './player-utils.js';

export function qualityChoices(levels, fallbackHeight = 0) {
  return levels.map((level, index) => {
    const height = level.height || (levels.length === 1 ? fallbackHeight : 0);
    const bitrate = Number(level.bitrate) || 0;
    const rate = bitrate >= 1000000 ? `${(bitrate / 1000000).toFixed(1)} Mbps`
      : bitrate > 0 ? `${Math.round(bitrate / 1000)} kbps` : '';
    const name = height ? `${height}p` : level.name || '';
    return { index, height, bitrate, label: [name, rate].filter(Boolean).join(' · ') || `Quality ${index + 1}` };
  }).sort((a, b) => b.height - a.height || b.bitrate - a.bitrate || a.index - b.index);
}

export function screenshotFilename(url, seconds) {
  const name = sourceLabel(url).replace(/\.(flv|m3u8|mp4)$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'video';
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const hours = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const minutes = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const remainder = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const millis = String(ms % 1000).padStart(3, '0');
  return `urlplay-${name}-${hours}-${minutes}-${remainder}-${millis}.png`;
}

function requireVideoFrame(video) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking) {
    throw new Error('Play the video or wait for seeking to finish before saving a screenshot.');
  }
}

async function waitForVideoFrame(video) {
  if (video.paused || typeof video.requestVideoFrameCallback !== 'function') return;
  let frameID;
  let timer;
  try {
    await new Promise((resolve) => {
      // A stalled/backgrounded video may never present another frame.
      timer = setTimeout(resolve, 250);
      frameID = video.requestVideoFrameCallback(resolve);
    });
  } finally {
    clearTimeout(timer);
    if (frameID !== undefined) video.cancelVideoFrameCallback?.(frameID);
  }
}

function pixelState(data) {
  let visible = false;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    visible = true;
    if (data[i] || data[i + 1] || data[i + 2]) return 'image';
  }
  return visible ? 'black' : 'empty';
}

// Some Android decoders cannot share their SurfaceTexture between the native
// compositor and WebGL. The fallback owns both presentation and capture, using
// one persistent texture/context per video instead of competing for the frame.
const videoReadbacks = new WeakMap();

function createFramePresenter(surface, video) {
  if (!video.parentElement) return null;
  const { gl, canvas } = surface;
  const shaders = [];
  let program;
  let vertices;
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 uv; void main(){ gl_Position=vec4(position,0.,1.); uv=vec2((position.x+1.)*.5,(1.-position.y)*.5); }'],
      [gl.FRAGMENT_SHADER, 'precision mediump float; varying vec2 uv; uniform sampler2D frame; void main(){ gl_FragColor=texture2D(frame,uv); }'],
    ]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Video renderer shader failed.');
    }
    program = gl.createProgram();
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Video renderer initialization failed.');
    vertices = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    const frame = gl.getUniformLocation(program, 'frame');
    canvas.className = 'frame-renderer';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('click', () => video.click());
    video.parentElement.insertBefore(canvas, video.nextSibling);
    video.classList.add('frame-rendered');
    return {
      draw() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, surface.width, surface.height);
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, surface.texture);
        gl.uniform1i(frame, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        canvas.hidden = false;
      },
      hide() { canvas.hidden = true; },
      destroy() {
        canvas.remove();
        video.classList.remove('frame-rendered');
        gl.deleteBuffer(vertices);
        gl.deleteProgram(program);
      },
    };
  } catch (error) {
    if (vertices) gl.deleteBuffer(vertices);
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

function updateVideoTexture(video, createCanvas) {
  // Firefox Android can display a hardware-decoded frame yet silently ignore
  // drawImage(video). Uploading to a GPU texture uses a different readback path.
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1526207
  const previous = videoReadbacks.get(video);
  const canvas = previous?.canvas || createCanvas();
  if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
  if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
  let gl = previous?.gl;
  let texture = previous?.texture;
  let framebuffer = previous?.framebuffer;
  if (previous) previous.valid = false;
  try {
    gl ||= canvas.getContext('webgl', {
      depth: false, stencil: false, antialias: false, preserveDrawingBuffer: true,
    });
    if (!gl) return false;
    if (gl.isContextLost()) return false;
    const { videoWidth: width, videoHeight: height } = video;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (width > maxSize || height > maxSize) return false;
    texture ||= gl.createTexture();
    framebuffer ||= gl.createFramebuffer();
    if (!texture || !framebuffer) return false;
    const surface = previous || { canvas, gl, texture, framebuffer };
    videoReadbacks.set(video, surface);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // readPixels reads the texture's first row first. Leaving upload unflipped
    // preserves the video's top-to-bottom order in the resulting ImageData.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
    if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) return false;
    Object.assign(surface, { source: video.currentSrc, width, height });
    // Android's decoded surface cannot reliably feed both the native video
    // compositor and WebGL. Display the same texture we retain for screenshots.
    if (!surface.presenter) surface.presenter = createFramePresenter(surface, video);
    surface.presenter?.draw();
    if (gl.getError() !== gl.NO_ERROR) return false;
    surface.valid = true;
    return surface;
  } catch (error) {
    if (error.name === 'SecurityError') throw error;
    return false;
  } finally {
    // Release partial/failed initialization only. In particular, do not call
    // WEBGL_lose_context after capture: Firefox Android still needs this context
    // for its cached hardware-decoded frame, even after pixels reach the CPU.
    if (videoReadbacks.get(video)?.gl !== gl) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      canvas.width = canvas.height = 0;
    }
  }
}

function readVideoTexture(video, context, createCanvas) {
  let surface = videoReadbacks.get(video);
  if (!surface) surface = updateVideoTexture(video, createCanvas);
  // Read the prepared texture, never re-import an already displayed frame.
  if (!surface?.valid || surface.source !== video.currentSrc) return false;
  const { gl, framebuffer, width, height } = surface;
  if (gl.isContextLost() || width !== video.videoWidth || height !== video.videoHeight) return false;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  if (gl.getError() !== gl.NO_ERROR || gl.isContextLost() || pixelState(pixels) === 'empty') return false;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return true;
}

export function prepareFrameCapture(video, createCanvas = () => document.createElement('canvas')) {
  // Run synchronously on loadeddata/seeked, before the compositor takes the
  // decoded surface. Firefox Android may expose only purple pixels if the
  // first GPU capture is initialized later, after the video frame is displayed.
  let canvas;
  try {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    if (videoReadbacks.has(video)) return !!updateVideoTexture(video, createCanvas);
    canvas = createCanvas();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    let state = 'empty';
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      state = pixelState(context.getImageData(0, 0, canvas.width, canvas.height).data);
    } catch (error) {
      if (!['InvalidStateError', 'NS_ERROR_NOT_AVAILABLE'].includes(error.name)) return false;
    }
    return state !== 'empty' || !!updateVideoTexture(video, createCanvas);
  } catch { return false; } // Report failures only if the viewer requests a capture.
  finally { if (canvas) canvas.width = canvas.height = 0; }
}

export function initFrameCapture(video, createCanvas = () => document.createElement('canvas'), userAgent = globalThis.navigator?.userAgent || '') {
  // Only Firefox Android needs ownership of the decoded surface before native
  // composition. Other browsers can briefly return empty pixels on loadeddata;
  // leave their normal renderer alone and capture on demand once a frame exists.
  if (!/Android/i.test(userAgent) || !/(?:Firefox|Fennec)\//.test(userAgent)) return { destroy() {} };
  let frameID = null;
  let generation = 0;
  function cancel() {
    generation++;
    if (frameID !== null) video.cancelVideoFrameCallback?.(frameID);
    frameID = null;
    const surface = videoReadbacks.get(video);
    if (surface) {
      surface.valid = false;
      surface.presenter?.hide();
    }
  }
  function queue() {
    if (frameID !== null || !videoReadbacks.has(video) || typeof video.requestVideoFrameCallback !== 'function') return;
    const current = generation;
    frameID = video.requestVideoFrameCallback(() => {
      if (current !== generation) return;
      frameID = null;
      prepareFrameCapture(video, createCanvas);
      queue();
    });
  }
  function prepare() {
    prepareFrameCapture(video, createCanvas);
    queue();
  }
  // Only browsers needing the GPU fallback copy each presented frame. No CPU
  // pixel readback or PNG encoding happens until a screenshot is requested.
  const events = ['loadeddata', 'seeked', 'resize'];
  for (const event of events) video.addEventListener(event, prepare);
  video.addEventListener('emptied', cancel);
  prepare();
  return { destroy() {
    cancel();
    videoReadbacks.get(video)?.presenter?.destroy();
    videoReadbacks.delete(video);
    for (const event of events) video.removeEventListener(event, prepare);
    video.removeEventListener('emptied', cancel);
  } };
}

export async function captureFrame(video, createCanvas = () => document.createElement('canvas')) {
  requireVideoFrame(video);
  const source = video.currentSrc;
  // Fresh canvases keep a previous source's CORS state out of future captures.
  const canvas = createCanvas();
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Screenshot capture is unavailable in this browser.');

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForVideoFrame(video);
    requireVideoFrame(video);
    if (video.currentSrc !== source) throw new DOMException('The video source changed during capture.', 'AbortError');
    // A stream can change resolution while we wait for its next frame.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    let captured = false;
    if (videoReadbacks.has(video)) {
      // Once the fallback owns the decoded surface, capture exactly the texture
      // shown in the player. A second native read can interfere with that owner.
      captured = readVideoTexture(video, context, createCanvas);
    } else {
      let state = 'empty';
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        state = pixelState(context.getImageData(0, 0, canvas.width, canvas.height).data);
      } catch (error) {
        if (error.name === 'SecurityError') throw error;
        if (!['InvalidStateError', 'NS_ERROR_NOT_AVAILABLE'].includes(error.name)) throw error;
      }
      // Opaque black may be the actual video frame. Only an empty/transparent
      // canvas indicates that drawing failed and needs the fallback.
      captured = state !== 'empty' || readVideoTexture(video, context, createCanvas);
    }
    if (!captured) {
      if (!video.paused && attempt === 0) continue;
      throw new Error('Your browser could not read this video frame. Try another browser or your device’s screenshot controls.');
    }
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The browser could not create the screenshot. Please try again.'));
      }, 'image/png');
    });
  }
}
