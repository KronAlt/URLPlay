// URL handling is shared by the player and its dependency-free Node tests.
export function normalizeSource(raw, base) {
  if (!raw || !raw.trim()) throw new Error('Paste a video or playlist URL first.');
  let url;
  try { url = new URL(raw.trim(), base); }
  catch { throw new Error('Enter a valid HTTP or HTTPS video URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS video URL.');
  if (url.username || url.password) throw new Error('Use a URL without embedded login credentials.');
  if (new URL(base).protocol === 'https:' && url.protocol === 'http:') {
    throw new Error('This page uses HTTPS. Use an HTTPS video URL to avoid blocked mixed content.');
  }
  return url.href;
}

export function detectFormat(url, selected = 'auto') {
  const pathname = new URL(url).pathname.toLowerCase();
  // Shared links may carry the previous source's type. Recognizable extensions
  // win; the selected format is a hint for endpoints without an extension.
  if (pathname.endsWith('.flv')) return 'flv';
  if (pathname.endsWith('.m3u8')) return 'hls';
  if (pathname.endsWith('.mp4')) return 'mp4';
  if (['flv', 'hls', 'mp4'].includes(selected)) return selected;
  throw new Error('Could not detect the format. Choose FLV, HLS / M3U8, or MP4 in the Format menu.');
}

export function isKnownLiveFLV(raw, selected = 'auto') {
  try {
    const url = new URL(raw);
    // This endpoint serves continuous FLV streams. Match the actual host and
    // path, never a hostname embedded in a query or another site's suffix.
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname === 'plwb.live.weibo.com' && url.pathname.startsWith('/alicdn/') &&
      detectFormat(url.href, selected) === 'flv';
  } catch { return false; }
}

export function readSource(search) {
  const params = new URLSearchParams(search);
  const url = params.get('url') || '';
  const type = ['flv', 'hls', 'mp4'].includes(params.get('type')) ? params.get('type') : 'auto';
  return {
    url,
    type,
    live: params.has('live') ? params.get('live') === '1' : isKnownLiveFLV(url, type),
  };
}

export function createPlayerLink(page, source) {
  const link = new URL(page);
  link.search = '';
  link.hash = '';
  link.searchParams.set('url', source.url);
  link.searchParams.set('type', source.type);
  if (source.live && ['flv', 'mp4'].includes(source.type)) link.searchParams.set('live', '1');
  else if (isKnownLiveFLV(source.url, source.type)) link.searchParams.set('live', '0');
  return link.href;
}

export function sourceLabel(url) {
  const parsed = new URL(url);
  let name = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
  try { name = decodeURIComponent(name); } catch { /* Keep malformed percent sequences as text. */ }
  // Signed URLs can have very long path tokens; show a useful host instead.
  return name.length > 90 ? parsed.hostname : name;
}
