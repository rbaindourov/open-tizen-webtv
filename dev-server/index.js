/**
 * Open WebTV - Unified Remote Logger, Media Server (SMB/Local/M3U) & Smart Hub Preview Host
 *
 * Provides:
 * - `GET /log` & `POST /log`: Real-time Tizen background service & UI telemetry logger (`GET /logs`).
 * - `GET /manifest.json`: Dynamic asset manifest for `src/manifest-loader.js`.
 * - `GET /preview.json`: Dynamic Samsung Smart Hub Preview (`bg_service`) feed with
 *   "Continue Watching", "SMB & Media Server Library", and "Featured Open Streams".
 * - `GET /api/catalog`: Full movie & channel catalog with metadata, codecs, subtitles, and resume state.
 * - `POST /api/sources/smb`: Add a mounted SMB/NAS directory at runtime.
 * - `POST /api/sources/m3u`: Import an `#EXTM3U` playlist at runtime.
 * - `POST /api/sources/stream`: Register a custom HTTP/HLS/MKV stream URL.
 * - `POST /api/progress`: Save playback resume timestamp (`Continue Watching`).
 * - `POST /api/favorites`: Toggle favorite status for any movie/channel.
 * - `GET /stream/:id`: RFC 7233 HTTP `206 Partial Content` byte-range video streamer for `.mp4`/`.mkv`.
 * - `GET /subtitles/:id.vtt`: On-the-fly `.srt` to `.vtt` WebVTT subtitle streamer.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  convertSrtToVtt,
  createMediaCatalogManager
} = require('./media-catalog');

const MAX_LOG_ENTRIES = 200;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const DEMO_VTT = `WEBVTT

00:00:00.500 --> 00:00:05.000
Open WebTV • Samsung Tizen Smart TV Media Center

00:00:05.500 --> 00:00:12.000
Use Left/Right or Rewind/FastForward keys to seek, and CC to toggle subtitles.

00:00:12.500 --> 00:00:25.000
Streaming with hardware AVPlay & HTML5 Byte-Range (HTTP 206) support.
`;

function createDevServer(options) {
  const opts = options || {};
  const silent = Boolean(opts.silent);
  const logBuffer = [];

  const catalogManager = createMediaCatalogManager({
    initialMediaDir: opts.mediaDir || process.env.MEDIA_DIR || null,
    initialMediaLabel: opts.mediaLabel || process.env.MEDIA_LABEL || 'Mounted SMB Share'
  });

  function recordLog(entry) {
    const record = {
      id: logBuffer.length + 1,
      timestamp: new Date().toISOString(),
      level: entry.level || 'info',
      source: entry.source || 'tizen-service',
      message: entry.message || '',
      data: entry.data !== undefined ? entry.data : null
    };
    logBuffer.push(record);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
      logBuffer.shift();
    }
    if (!silent) {
      const dataPreview =
        record.data !== null
          ? ' | data=' + (typeof record.data === 'string' ? record.data : JSON.stringify(record.data))
          : '';
      console.log(
        `[${record.timestamp}] [${record.level.toUpperCase()}] (${record.source}) ${record.message}${dataPreview}`
      );
    }
    return record;
  }

  function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(body);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Invalid JSON request body'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStaticFile(res, filePath) {
    fs.readFile(filePath, (err, content) => {
      if (err) {
        sendJson(res, 404, { error: 'Not Found', path: path.basename(filePath) });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    });
  }

  /**
   * Streams a local/SMB video file with RFC 7233 HTTP 206 Partial Content byte-range support.
   */
  function streamVideoFile(req, res, item) {
    if (!item || !item.filePath || !fs.existsSync(item.filePath)) {
      sendJson(res, 404, { error: 'Video file not found on disk' });
      return;
    }

    const stat = fs.statSync(item.filePath);
    const fileSize = stat.size;
    const contentType = item.mimeType || 'video/mp4';
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end();
        return;
      }

      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1) : fileSize - 1;

      if (start >= fileSize || start > end) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Access-Control-Allow-Origin': '*'
        });
        res.end();
        return;
      }

      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });

      const stream = fs.createReadStream(item.filePath, { start, end });
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    const stream = fs.createReadStream(item.filePath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  }

  function renderPosterSvg(slug, customItem) {
    const paletteMap = {
      'big-buck-bunny': ['#0284c7', '#38bdf8', 'Big Buck Bunny', '1080p • H.264'],
      sintel: ['#7c3aed', '#c084fc', 'Sintel', '1080p • H.264'],
      'tears-of-steel': ['#0f766e', '#2dd4bf', 'Tears of Steel', '1080p • Sci-Fi'],
      'cosmos-laundromat': ['#1d4ed8', '#60a5fa', 'Elephants Dream', '1080p • Open Movie'],
      spring: ['#15803d', '#4ade80', 'Spring', '1080p • Open Movie'],
      charge: ['#b91c1c', '#f87171', 'Charge', '1080p • Action']
    };
    const key = String(slug || '').replace(/\.svg$/i, '');
    let theme = paletteMap[key];
    if (!theme && customItem) {
      theme = [
        '#1e293b',
        '#38bdf8',
        customItem.title,
        `${customItem.resolution || 'HD'} • ${customItem.videoCodec || 'STREAM'}`
      ];
    } else if (!theme) {
      theme = ['#334155', '#94a3b8', 'SMB / Media Stream', 'Open WebTV • Direct Play'];
    }

    const safeTitle = String(theme[2]).replace(/[<>&"']/g, '');
    const safeSub = String(theme[3]).replace(/[<>&"']/g, '');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${theme[0]}" />
          <stop offset="100%" stop-color="#0f172a" />
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#g)" rx="16" />
      <circle cx="540" cy="80" r="110" fill="${theme[1]}" fill-opacity="0.14" />
      <rect x="40" y="40" width="128" height="34" rx="8" fill="${theme[1]}" fill-opacity="0.25" />
      <text x="104" y="63" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="bold" text-anchor="middle">${safeSub}</text>
      <text x="40" y="265" fill="#ffffff" font-family="sans-serif" font-size="34" font-weight="bold">${safeTitle}</text>
      <text x="40" y="305" fill="#cbd5e1" font-family="sans-serif" font-size="18">Open WebTV • Direct Stream Ready</text>
    </svg>`;
  }

  const server = http.createServer(async (req, res) => {
    const hostHeader = req.headers.host || '127.0.0.1:4000';
    const baseOrigin = `http://${hostHeader}`;
    const parsedUrl = new URL(req.url || '/', baseOrigin);
    const pathname = parsedUrl.pathname || '/';
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // 1. Health check
    if (pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'open-tizen-webtv-dev-server',
        logCount: logBuffer.length,
        mediaDirsCount: catalogManager.mediaDirs.length
      });
      return;
    }

    // 2. Remote Logger Endpoint (GET or POST /log)
    if (pathname === '/log') {
      if (req.method === 'POST') {
        try {
          const payload = await readJsonBody(req);
          const entry = recordLog({
            level: payload.level || query.level || 'info',
            source: payload.source || query.source || 'tizen-service',
            message: payload.message || query.message || 'Log event',
            data: payload.data !== undefined ? payload.data : query.data
          });
          sendJson(res, 200, { ok: true, entry });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return;
      }

      let parsedData = query.data;
      if (typeof parsedData === 'string') {
        try {
          parsedData = JSON.parse(parsedData);
        } catch (e) {}
      }
      const entry = recordLog({
        level: query.level || 'info',
        source: query.source || 'tizen-service',
        message: query.message || JSON.stringify(query),
        data: parsedData
      });
      sendJson(res, 200, { ok: true, entry });
      return;
    }

    // 3. Inspect or Clear Logs (/logs)
    if (pathname === '/logs') {
      if (req.method === 'DELETE') {
        logBuffer.length = 0;
        sendJson(res, 200, { ok: true, logs: [] });
        return;
      }
      sendJson(res, 200, { logs: logBuffer });
      return;
    }

    // 4. Dynamic Application Manifest (/manifest.json)
    if (pathname === '/manifest.json') {
      sendJson(res, 200, {
        'styles.css': `${baseOrigin}/assets/styles.css`,
        'core.js': `${baseOrigin}/assets/core.js`,
        'player.js': `${baseOrigin}/assets/player.js`,
        'app.js': `${baseOrigin}/assets/app.js`
      });
      return;
    }

    // 5. Smart Hub Preview Feed (/preview.json)
    if (pathname === '/preview.json') {
      const previewPayload = catalogManager.buildSmartHubPreview(baseOrigin);
      sendJson(res, 200, previewPayload);
      return;
    }

    // 6. Media Catalog & Sources API (/api/catalog, /api/sources/*, /api/progress, /api/favorites)
    if (pathname === '/api/catalog' && req.method === 'GET') {
      const items = catalogManager.getAllItems(baseOrigin);
      sendJson(res, 200, {
        items,
        sources: catalogManager.mediaDirs
      });
      return;
    }

    if (pathname === '/api/sources/smb' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const dirEntry = catalogManager.addMediaDirectory(body.path, body.label);
        const items = catalogManager.getAllItems(baseOrigin);
        recordLog({
          source: 'media-catalog',
          message: `Mounted SMB/local directory: ${dirEntry.path}`,
          data: { label: dirEntry.label, totalItems: items.length }
        });
        sendJson(res, 200, { ok: true, source: dirEntry, items });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/sources/m3u' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const imported = catalogManager.addM3uContent(body.content, body.label);
        recordLog({
          source: 'media-catalog',
          message: `Imported M3U playlist (${imported.length} streams)`,
          data: { label: body.label }
        });
        sendJson(res, 200, {
          ok: true,
          importedCount: imported.length,
          items: catalogManager.getAllItems(baseOrigin)
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/sources/stream' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const added = catalogManager.addCustomStream(body);
        recordLog({
          source: 'media-catalog',
          message: `Added custom stream: ${added.title}`,
          data: { streamUrl: added.streamUrl }
        });
        sendJson(res, 200, {
          ok: true,
          item: added,
          items: catalogManager.getAllItems(baseOrigin)
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/progress' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const progress = catalogManager.updateWatchProgress(
          body.itemId,
          body.positionSec,
          body.durationSec
        );
        sendJson(res, 200, { ok: true, progress });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (pathname === '/api/favorites' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const isFavorite = catalogManager.toggleFavorite(body.itemId);
        sendJson(res, 200, { ok: true, itemId: body.itemId, isFavorite });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    // 7. HTTP 206 Byte-Range Video Streamer (/stream/:id)
    if (pathname.startsWith('/stream/')) {
      const itemId = pathname.replace(/^\/stream\//, '');
      const item = catalogManager.getItemById(itemId, baseOrigin);
      streamVideoFile(req, res, item);
      return;
    }

    // 8. WebVTT Subtitle Streamer & SRT-to-VTT Converter (/subtitles/:id.vtt)
    if (pathname.startsWith('/subtitles/') && pathname.endsWith('.vtt')) {
      const subId = path.basename(pathname, '.vtt');
      if (subId === 'demo') {
        res.writeHead(200, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(DEMO_VTT);
        return;
      }

      const item = catalogManager.getItemById(subId, baseOrigin);
      if (!item || !item.subtitlePath || !fs.existsSync(item.subtitlePath)) {
        sendJson(res, 404, { error: 'Subtitle track not found' });
        return;
      }

      const rawSub = fs.readFileSync(item.subtitlePath, 'utf8');
      const vttContent = item.subtitleFormat === 'srt' ? convertSrtToVtt(rawSub) : rawSub;
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(vttContent);
      return;
    }

    // 9. Dynamic SVG Posters (/assets/posters/*.svg)
    if (pathname.startsWith('/assets/posters/') && pathname.endsWith('.svg')) {
      const slug = path.basename(pathname, '.svg');
      const customId = slug.startsWith('media-') ? slug.replace(/^media-/, '') : null;
      const customItem = customId ? catalogManager.getItemById(customId, baseOrigin) : null;
      const svg = renderPosterSvg(slug, customItem);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(svg);
      return;
    }

    // 10. Reference 10-foot WebTV UI Bundles (/assets/*)
    if (pathname.startsWith('/assets/')) {
      const relAsset = pathname.replace(/^\/assets\//, '');
      const safeAssetPath = path.resolve(__dirname, 'public', relAsset);
      if (safeAssetPath.startsWith(path.resolve(__dirname, 'public'))) {
        serveStaticFile(res, safeAssetPath);
        return;
      }
    }

    // 11. Serve Tizen Wrapper App directly (/ or /index.html)
    if (pathname === '/' || pathname === '/index.html') {
      serveStaticFile(res, path.resolve(__dirname, '../src/index.html'));
      return;
    }

    const srcCandidate = path.resolve(__dirname, '../src', pathname.replace(/^\/+/, ''));
    if (
      srcCandidate.startsWith(path.resolve(__dirname, '../src')) &&
      fs.existsSync(srcCandidate) &&
      fs.statSync(srcCandidate).isFile()
    ) {
      serveStaticFile(res, srcCandidate);
      return;
    }

    sendJson(res, 404, { error: 'Route not found', pathname });
  });

  return {
    server,
    logBuffer,
    recordLog,
    catalogManager
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  const { server, catalogManager } = createDevServer();
  server.listen(port, () => {
    console.log('==============================================================');
    console.log(`Open WebTV Media Server & Remote Logger listening on port ${port}`);
    console.log(`- 10-Foot TV Media Center: http://127.0.0.1:${port}/`);
    console.log(`- Media Catalog API:       http://127.0.0.1:${port}/api/catalog`);
    console.log(`- Dynamic Manifest:        http://127.0.0.1:${port}/manifest.json`);
    console.log(`- Smart Hub Preview Feed:  http://127.0.0.1:${port}/preview.json`);
    console.log(`- Remote Logger Sink:      http://127.0.0.1:${port}/log?message=hello`);
    if (catalogManager.mediaDirs.length > 0) {
      console.log(`- Mounted SMB/Media Dirs:  ${catalogManager.mediaDirs.map((d) => d.path).join(', ')}`);
    } else {
      console.log(`- Tip: Set MEDIA_DIR=/path/to/movies or add an SMB folder from the TV UI!`);
    }
    console.log('==============================================================');
  });
}

module.exports = {
  createDevServer
};
