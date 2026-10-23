# Browser playback libraries

These pinned distribution bundles are served locally, with no CDN runtime dependency.

| Library | Version | Distribution | License |
| --- | --- | --- | --- |
| mpegts.js | 1.8.0 | https://cdn.jsdelivr.net/npm/mpegts.js@1.8.0/dist/mpegts.js | Apache 2.0, see `mpegts-LICENSE` |
| hls.js | 1.6.13 | https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js | BSD 2-Clause, see `hls-LICENSE` |
| MP4Box.js | 2.4.1 | https://cdn.jsdelivr.net/npm/mp4box@2.4.1/dist/mp4box.all.mjs (and its two local module dependencies) | BSD 3-Clause, see `mp4box-2.4.1/LICENSE` |

Upstream documentation: https://github.com/xqq/mpegts.js and https://github.com/video-dev/hls.js

MP4 metadata parsing: https://github.com/gpac/mp4box.js. Its local modules are loaded only when a live MP4 initialization segment needs inspection.
