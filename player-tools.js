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

export function captureFrame(video, createCanvas = () => document.createElement('canvas')) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking) {
    return Promise.reject(new Error('Play the video or wait for seeking to finish before saving a screenshot.'));
  }
  return new Promise((resolve, reject) => {
    // A fresh canvas keeps a previous source's CORS state out of future captures.
    const canvas = createCanvas();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Screenshot capture is unavailable in this browser.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not create the screenshot. Please try again.'));
    }, 'image/png');
  });
}
