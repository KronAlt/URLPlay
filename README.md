# URLplay

URLplay is a browser-based video player for direct FLV, MP4, and HLS (`.m3u8`) links. It runs entirely with client-side HTML, CSS, and JavaScript, without uploads, accounts, or a server application.

## Interface and functionality

Paste a video URL, select **Load video**, and press the centered **Play** button. The format is detected automatically, with a manual format selector available. Weibo FLV links on `plwb.live.weibo.com/alicdn/` automatically enable live mode. For other live FLV streams or growing and continuously streamed fragmented MP4, enable **Live FLV / MP4**; completed MP4 files play directly through the browser.

The player includes:

- Play/pause, seeking, elapsed time, volume, mute, and fullscreen controls.
- **Live** to return to the latest available video, with live FLV/MP4 seeking limited to retained data and automatic recovery from stalled live seeks.
- Automatic or manual quality selection when an HLS master playlist offers multiple renditions.
- **Save screenshot** to download the current video frame as a full-resolution PNG.
- Quality and screenshot controls available in fullscreen.
- **Copy player link** to share a source ready to play. Links accept an encoded `url` GET parameter, with optional `type=flv|mp4|hls` and `live=1` parameters. Playback waits for the viewer to press Play.

A bundled example video is loaded initially. External media must allow browser access through CORS and use supported codecs. Live MP4 requires fragmented MP4 with initialization metadata available at the beginning.

## Libraries

- [mpegts.js 1.8.0](https://github.com/xqq/mpegts.js) — FLV playback through Media Source Extensions.
- [hls.js 1.6.13](https://github.com/video-dev/hls.js) — HLS playback and adaptive/manual quality selection, with native HLS used as a fallback.
- [MP4Box.js 2.4.1](https://github.com/gpac/mp4box.js) — reads initialization metadata and codecs for the custom live fragmented-MP4 reader.

Libraries are bundled locally in `vendor/`; playback requires no runtime CDN dependencies. The interface uses plain JavaScript without a UI framework.
