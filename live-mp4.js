const MAX_BOX_SIZE = 64 * 1024 * 1024;
const LIVE_FORMAT_HELP = 'Live MP4 requires fragmented MP4 (fMP4) with initialization metadata at the beginning. A normal MP4 that writes its metadata only when recording ends cannot play while growing. Uncheck Live for a completed file.';

export function joinBytes(parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

// HTTP chunks and growing-file snapshots can end anywhere, including mid-box.
export class MP4BoxReader {
  pending = new Uint8Array();
  constructor(onBox) { this.onBox = onBox; }
  async push(bytes) {
    this.pending = joinBytes([this.pending, bytes]);
    while (this.pending.length >= 8) {
      const view = new DataView(this.pending.buffer, this.pending.byteOffset, this.pending.byteLength);
      let size = view.getUint32(0);
      let headerSize = 8;
      if (size === 1) {
        if (this.pending.length < 16) return;
        size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
        headerSize = 16;
      }
      if (size === 0) throw new Error(`An open-ended MP4 box cannot be followed while growing. ${LIVE_FORMAT_HELP}`);
      if (size < headerSize || size > MAX_BOX_SIZE) throw new Error(`Invalid or oversized MP4 box (maximum 64 MiB per fragment box). ${LIVE_FORMAT_HELP}`);
      if (this.pending.length < size) return;
      const type = String.fromCharCode(...this.pending.subarray(4, 8));
      const box = this.pending.slice(0, size);
      this.pending = this.pending.slice(size);
      await this.onBox(type, box);
    }
  }
}

export async function mp4MimeType(initialization) {
  const { createFile } = await import('./vendor/mp4box-2.4.1/mp4box.all.mjs');
  const file = createFile();
  let info;
  let parseError;
  file.onReady = (value) => { info = value; };
  file.onError = () => { parseError = true; };
  const buffer = initialization.slice().buffer;
  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  if (parseError || !info) throw new Error('The MP4 initialization metadata could not be read.');
  if (!info.isFragmented) throw new Error(LIVE_FORMAT_HELP);
  const tracks = info.tracks.filter((track) => track.video || track.audio);
  if (!tracks.length || tracks.some((track) => !track.codec)) throw new Error('This MP4 has no supported video or audio track.');
  const container = tracks.some((track) => track.video) ? 'video/mp4' : 'audio/mp4';
  return `${container}; codecs="${tracks.map((track) => track.codec).join(', ')}"`;
}

export function validateRange(response, offset) {
  const range = response.headers.get('Content-Range');
  if (response.status === 416) {
    const match = /^bytes \*\/(\d+)$/i.exec(range || '');
    if (!match) throw new Error('The MP4 host must return Content-Range on range responses and expose it through CORS.');
    if (Number(match[1]) < offset) throw new Error('The growing MP4 was truncated or replaced. Load its new URL to restart playback.');
    return;
  }
  if (offset > 0 && response.status !== 206) throw new Error('The MP4 host ignored a byte-range request. Growing files require HTTP Range support, or a continuous streaming response.');
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(range || '');
    if (!match) throw new Error('The MP4 host must return Content-Range and expose it through CORS so playback can resume safely.');
    if (Number(match[1]) !== offset || Number(match[2]) < offset) throw new Error('The MP4 host returned the wrong byte range. Playback stopped to avoid duplicating or skipping video data.');
  }
}

function abortError() { return new DOMException('Playback stopped.', 'AbortError'); }

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export class LiveMP4Player {
  constructor(video, url, onError) {
    this.video = video;
    this.url = url;
    this.onError = onError;
    this.controller = new AbortController();
    this.offset = 0;
    this.initialization = [];
    this.positioned = false;
    const MediaSourceClass = globalThis.MediaSource || globalThis.ManagedMediaSource;
    if (!MediaSourceClass) throw new Error('Live MP4 needs Media Source Extensions. Try a recent Chrome, Firefox, Edge, or Safari browser.');
    this.mediaSource = new MediaSourceClass();
    this.MediaSourceClass = MediaSourceClass;
    this.reader = new MP4BoxReader((type, box) => this.box(type, box));
  }

  load() {
    this.run().catch((error) => {
      if (!this.controller.signal.aborted) this.onError(error);
    });
  }

  destroy() {
    this.controller.abort();
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
  }

  async run() {
    const { signal } = this.controller;
    await new Promise((resolve, reject) => {
      const done = (error) => {
        this.mediaSource.removeEventListener('sourceopen', opened);
        signal.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve();
      };
      const opened = () => done();
      const cancelled = () => done(abortError());
      this.mediaSource.addEventListener('sourceopen', opened, { once: true });
      signal.addEventListener('abort', cancelled, { once: true });
      this.objectURL = URL.createObjectURL(this.mediaSource);
      this.video.src = this.objectURL;
      this.video.load();
    });
    await this.follow();
  }

  async box(type, box) {
    if (this.controller.signal.aborted) throw abortError();
    if (type === 'ftyp') {
      if (this.sourceBuffer || this.initialization.length) throw new Error('The live MP4 initialization unexpectedly restarted. Reload the source.');
      this.initialization.push(box);
    } else if (type === 'moov') {
      if (this.sourceBuffer || !this.initialization.length) throw new Error(LIVE_FORMAT_HELP);
      const init = joinBytes([...this.initialization, box]);
      const mime = await mp4MimeType(init);
      if (this.controller.signal.aborted) throw abortError();
      if (!this.MediaSourceClass.isTypeSupported(mime)) throw new Error(`This browser cannot decode the live MP4 codecs (${mime}).`);
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      this.mediaSource.duration = Infinity;
      this.initialization = [];
      await this.update(() => this.sourceBuffer.appendBuffer(init));
    } else if (type === 'moof' || type === 'mdat') {
      if (!this.sourceBuffer) throw new Error(LIVE_FORMAT_HELP);
      if (type === 'moof') {
        // Keep finite forward/backward buffers and apply backpressure to fetch.
        while (this.bufferedAhead() > 60) await delay(500, this.controller.signal);
        const cutoff = this.video.currentTime - 60;
        if (cutoff > 0 && this.sourceBuffer.buffered.length && this.sourceBuffer.buffered.start(0) < cutoff) {
          await this.update(() => this.sourceBuffer.remove(0, cutoff));
        }
      }
      await this.update(() => this.sourceBuffer.appendBuffer(box));
      const ranges = this.sourceBuffer.buffered;
      if (ranges.length) {
        const start = ranges.start(0);
        const end = ranges.end(ranges.length - 1);
        if (!this.positioned) {
          this.positioned = true;
          if (this.video.currentTime < start) this.video.currentTime = start;
        }
        if (end > start && this.mediaSource.setLiveSeekableRange) this.mediaSource.setLiveSeekableRange(start, end);
      }
    }
    // Indexes and optional top-level metadata are not media samples.
  }

  bufferedAhead() {
    const ranges = this.sourceBuffer.buffered;
    return ranges.length ? ranges.end(ranges.length - 1) - this.video.currentTime : 0;
  }

  update(operation) {
    const { signal } = this.controller;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const buffer = this.sourceBuffer;
      const done = (error) => {
        buffer.removeEventListener('updateend', updated);
        buffer.removeEventListener('error', failed);
        buffer.removeEventListener('abort', cancelled);
        signal.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve();
      };
      const updated = () => done();
      const failed = () => done(new Error(`The browser rejected an MP4 fragment. Check that the stream uses browser-compatible codecs and movie-fragment-relative addressing. ${LIVE_FORMAT_HELP}`));
      const cancelled = () => done(abortError());
      buffer.addEventListener('updateend', updated, { once: true });
      buffer.addEventListener('error', failed, { once: true });
      buffer.addEventListener('abort', cancelled, { once: true });
      signal.addEventListener('abort', cancelled, { once: true });
      try { operation(); } catch (error) { done(error); }
    });
  }

  async follow() {
    const { signal } = this.controller;
    let failures = 0;
    const retry = async (status) => {
      if (signal.aborted) throw abortError();
      if (++failures > 5) {
        const error = new Error('The live MP4 connection could not be resumed.');
        error.network = true;
        error.status = status;
        throw error;
      }
      await delay(Math.min(500 * 2 ** failures, 8000), signal);
    };
    while (!signal.aborted) {
      let response;
      try {
        response = await fetch(this.url, {
          mode: 'cors', cache: 'no-store', signal,
          headers: this.offset ? { Range: `bytes=${this.offset}-` } : {},
        });
      } catch {
        await retry();
        continue;
      }
      if (response.status !== 416 && !response.ok) {
        await response.body?.cancel();
        if (response.status >= 500 || [408, 429].includes(response.status)) { await retry(response.status); continue; }
        const error = new Error('The live MP4 host returned an error.');
        error.network = true;
        error.status = response.status;
        throw error;
      }
      try { validateRange(response, this.offset); }
      catch (error) { await response.body?.cancel(); throw error; }
      if (response.status === 416) {
        await response.body?.cancel();
        failures = 0;
        await delay(1000, signal);
        continue;
      }
      if (!response.body) throw new Error('This browser cannot read a streaming MP4 response.');
      const reader = response.body.getReader();
      let disconnected = false;
      try {
        while (!signal.aborted) {
          let result;
          try { result = await reader.read(); }
          catch { disconnected = true; break; }
          if (result.done) break;
          this.offset += result.value.byteLength;
          failures = 0;
          await this.reader.push(result.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (disconnected) await retry();
      else await delay(1000, signal);
    }
  }
}
