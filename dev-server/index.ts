/**
 * Open WebTV - Strictly Typed Unified Remote Logger, Media Server (SMB/Local/M3U) & Smart Hub Preview Host
 *
 * Provides:
 * - `GET /log` & `POST /log`: Real-time Tizen background service & UI telemetry logger (`GET /logs`).
 * - `GET /manifest.json`: Dynamic asset manifest for `src/manifest-loader.ts`.
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
 * - `GET /assets/background.svg`, `/assets/posters/*.svg`, `/assets/backgrounds/*.svg`: Unique vector assets.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderAmbientBackgroundSvg,
  renderBackdropSvg,
  renderPosterSvg
} from './assets.ts';
import {
  convertSrtToVtt,
  createMediaCatalogManager
} from './media-catalog.ts';
import { transpileFileForTizenBrowser } from '../scripts/transpile-tizen.ts';
import type {
  CatalogItem,
  CustomStreamInput,
  DevServerOptions,
  MediaCatalogManager,
  TelemetryLogEntry,
  TelemetryLogInput
} from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_LOG_ENTRIES = 200;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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

export interface DevServerInstance {
  readonly server: http.Server;
  readonly logBuffer: TelemetryLogEntry[];
  recordLog(entry: TelemetryLogInput): TelemetryLogEntry;
  readonly catalogManager: MediaCatalogManager;
}

export function createDevServer(options?: DevServerOptions): DevServerInstance {
  const opts: DevServerOptions = options ?? {};
  const silent = Boolean(opts.silent);
  const logBuffer: TelemetryLogEntry[] = [];

  const catalogManager = createMediaCatalogManager({
    initialMediaDir: opts.mediaDir ?? process.env.MEDIA_DIR ?? null,
    initialMediaLabel: opts.mediaLabel ?? process.env.MEDIA_LABEL ?? 'Mounted SMB Share'
  });

  function recordLog(entry: TelemetryLogInput): TelemetryLogEntry {
    const record: TelemetryLogEntry = {
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
          ? ' | data=' +
            (typeof record.data === 'string'
              ? record.data
              : JSON.stringify(record.data))
          : '';
      console.log(
        `[${record.timestamp}] [${record.level.toUpperCase()}] (${record.source}) ${record.message}${dataPreview}`
      );
    }
    return record;
  }

  function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(body);
  }

  function readJsonBody<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer | string) => {
        body += String(chunk);
      });
      req.on('end', () => {
        if (!body) {
          resolve({} as T);
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (_err: unknown) {
          reject(new Error('Invalid JSON request body'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStaticFile(res: http.ServerResponse, filePath: string): void {
    fs.readFile(filePath, (err, content) => {
      if (err) {
        sendJson(res, 404, { error: 'Not Found', path: path.basename(filePath) });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    });
  }

  function serveTranspiledTsAsJs(res: http.ServerResponse, tsFilePath: string): void {
    try {
      const jsContent = transpileFileForTizenBrowser(tsFilePath);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(jsContent);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: 'TypeScript transpilation failed', message });
    }
  }

  /**
   * Streams a local/SMB video file with RFC 7233 HTTP 206 Partial Content byte-range support.
   */
  function streamVideoFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    item: CatalogItem | null
  ): void {
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

      const startStr = match[1] ?? '';
      const endStr = match[2] ?? '';
      const start = startStr ? parseInt(startStr, 10) : 0;
      const end = endStr ? Math.min(parseInt(endStr, 10), fileSize - 1) : fileSize - 1;

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
          const payload = await readJsonBody<TelemetryLogInput>(req);
          const entry = recordLog({
            level: payload.level || 'info',
            source: payload.source || 'tizen-service',
            message: payload.message || '',
            data: payload.data
          });
          sendJson(res, 200, { ok: true, entry });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { ok: false, error: msg });
        }
        return;
      }

      let parsedData: unknown = query.data !== undefined ? query.data : null;
      if (typeof parsedData === 'string' && parsedData.length > 0) {
        try {
          parsedData = JSON.parse(parsedData);
        } catch (_e: unknown) {
          // keep as raw string
        }
      }

      const entry = recordLog({
        level: query.level || 'info',
        source: query.source || 'tizen-service',
        message: query.message || '',
        data: parsedData
      });
      sendJson(res, 200, { ok: true, entry });
      return;
    }

    // 3. Log Inspection & Reset (/logs)
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
        const body = await readJsonBody<{ path?: string; label?: string }>(req);
        const dirEntry = catalogManager.addMediaDirectory(body.path || '', body.label);
        const items = catalogManager.getAllItems(baseOrigin);
        recordLog({
          source: 'media-catalog',
          message: `Mounted SMB/local directory: ${dirEntry.path}`,
          data: { label: dirEntry.label, totalItems: items.length }
        });
        sendJson(res, 200, { ok: true, source: dirEntry, items });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }

    if (pathname === '/api/sources/m3u' && req.method === 'POST') {
      try {
        const body = await readJsonBody<{ content?: string; label?: string }>(req);
        const imported = catalogManager.addM3uContent(body.content || '', body.label);
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }

    if (pathname === '/api/sources/stream' && req.method === 'POST') {
      try {
        const body = await readJsonBody<CustomStreamInput>(req);
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }

    if (pathname === '/api/progress' && req.method === 'POST') {
      try {
        const body = await readJsonBody<{
          itemId?: string;
          positionSec?: number;
          durationSec?: number;
        }>(req);
        const progress = catalogManager.updateWatchProgress(
          body.itemId || '',
          body.positionSec ?? 0,
          body.durationSec ?? 0
        );
        sendJson(res, 200, { ok: true, progress });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }

    if (pathname === '/api/favorites' && req.method === 'POST') {
      try {
        const body = await readJsonBody<{ itemId?: string }>(req);
        const isFavorite = catalogManager.toggleFavorite(body.itemId || '');
        sendJson(res, 200, { ok: true, itemId: body.itemId, isFavorite });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
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
      const vttContent =
        item.subtitleFormat === 'srt' ? convertSrtToVtt(rawSub) : rawSub;
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(vttContent);
      return;
    }

    // 9. Local Sidecar Artwork Streamer (/artwork/:id/poster, /artwork/:id/backdrop)
    if (pathname.startsWith('/artwork/')) {
      const parts = pathname.replace(/^\/artwork\//, '').split('/');
      const itemId = parts[0] || '';
      const kind = parts[1] || 'poster';
      const item = catalogManager.getItemById(itemId, baseOrigin);
      const artPath =
        kind === 'backdrop' ? item?.backdropFilePath : item?.posterFilePath;
      if (artPath && fs.existsSync(artPath)) {
        serveStaticFile(res, artPath);
        return;
      }
      sendJson(res, 404, { error: 'Sidecar artwork not found' });
      return;
    }

    // 10. Bespoke Ambient Cinema Background SVG (/assets/background.svg)
    if (pathname === '/assets/background.svg') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(renderAmbientBackgroundSvg());
      return;
    }

    // 11. Unique Dynamic SVG Posters (/assets/posters/*.svg)
    if (pathname.startsWith('/assets/posters/') && pathname.endsWith('.svg')) {
      const slug = path.basename(pathname, '.svg');
      const customId = slug.startsWith('media-') ? slug.replace(/^media-/, '') : null;
      const customItem = customId
        ? catalogManager.getItemById(customId, baseOrigin)
        : null;
      const svg = renderPosterSvg(slug, customItem);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(svg);
      return;
    }

    // 12. Unique Dynamic SVG Widescreen Stage Backdrops (/assets/backgrounds/*.svg)
    if (pathname.startsWith('/assets/backgrounds/') && pathname.endsWith('.svg')) {
      const slug = path.basename(pathname, '.svg');
      const customId = slug.startsWith('media-') ? slug.replace(/^media-/, '') : null;
      const customItem = customId
        ? catalogManager.getItemById(customId, baseOrigin)
        : null;
      const svg = renderBackdropSvg(slug, customItem);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(svg);
      return;
    }

    // 13. Reference 10-foot WebTV UI Bundles (/assets/*)
    if (pathname.startsWith('/assets/')) {
      const relAsset = pathname.replace(/^\/assets\//, '');
      const publicDir = path.resolve(__dirname, 'public');
      const safeAssetPath = path.resolve(publicDir, relAsset);
      if (safeAssetPath.startsWith(publicDir)) {
        if (safeAssetPath.endsWith('.js')) {
          const tsCandidate = safeAssetPath.replace(/\.js$/, '.ts');
          if (fs.existsSync(tsCandidate)) {
            serveTranspiledTsAsJs(res, tsCandidate);
            return;
          }
        }
        if (fs.existsSync(safeAssetPath) && fs.statSync(safeAssetPath).isFile()) {
          serveStaticFile(res, safeAssetPath);
          return;
        }
      }
    }

    // 14. Serve Tizen Wrapper App directly (/ or /index.html or /app-ipc-bridge.js or /manifest-loader.js)
    if (pathname === '/' || pathname === '/index.html') {
      serveStaticFile(res, path.resolve(__dirname, '../src/index.html'));
      return;
    }

    const srcDir = path.resolve(__dirname, '../src');
    const srcCandidate = path.resolve(srcDir, pathname.replace(/^\/+/, ''));
    if (srcCandidate.startsWith(srcDir)) {
      if (srcCandidate.endsWith('.js')) {
        const tsSrcCandidate = srcCandidate.replace(/\.js$/, '.ts');
        if (fs.existsSync(tsSrcCandidate)) {
          serveTranspiledTsAsJs(res, tsSrcCandidate);
          return;
        }
      }
      if (fs.existsSync(srcCandidate) && fs.statSync(srcCandidate).isFile()) {
        serveStaticFile(res, srcCandidate);
        return;
      }
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

const isMainModule =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);

if (isMainModule) {
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
      console.log(
        `- Mounted SMB/Media Dirs:  ${catalogManager.mediaDirs.map((d) => d.path).join(', ')}`
      );
    } else {
      console.log(
        `- Tip: Set MEDIA_DIR=/path/to/movies or add an SMB folder from the TV UI!`
      );
    }
    console.log('==============================================================');
  });
}
