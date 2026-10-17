/**
 * Open WebTV - Strictly Typed Automated Unit & Integration Test Suite
 *
 * Covers:
 * 1. Configuration & cross-file ID synchronization (with negative control verification)
 * 2. Dynamic manifest loader (`src/manifest-loader.ts`) asset ordering, retries, and error fallback
 * 3. Foreground Tizen IPC & remote key bridge (`src/app-ipc-bridge.ts`)
 * 4. Background Smart Hub Preview service (`src/service/service.ts`) & HTTP request helper
 * 5. Filename metadata parser, SRT-to-VTT subtitle converter, and M3U playlist parser
 * 6. Hybrid Video Player Engine (`AVPlay` hardware + `HTML5 <video>`) & Deep-Link (`appcontrol`) resolver
 * 7. SMB/Local directory mounting, HTTP `206 Partial Content` byte-range streaming, SRT-to-VTT endpoint,
 *    and Watch Progress (`Continue Watching` in `/preview.json`)
 * 8. Asset & Background Uniqueness (`src/logo.png`, `src/background.png`, `/assets/background.svg`,
 *    built-in & dynamic SVG posters/backdrops, and SMB sidecar artwork)
 * 9. TypeScript-to-Tizen JS transpilation & `.wgt` archive packaging
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  createBackgroundPngBuffer,
  createLogoPngBuffer,
  renderAmbientBackgroundSvg,
  renderBackdropSvg,
  renderPosterSvg
} from '../dev-server/assets.ts';
import { createDevServer } from '../dev-server/index.ts';
import {
  convertSrtToVtt,
  createMediaCatalogManager,
  getBuiltInOpenStreams,
  parseM3uPlaylist,
  parseMediaFilename
} from '../dev-server/media-catalog.ts';
import {
  cloneCatalogItem,
  escapeHtml,
  resolveServerUrl
} from '../dev-server/public/app.ts';
import * as OpenWebTVPlayer from '../dev-server/public/player.ts';
import type { CatalogItem } from '../dev-server/types.ts';
import { buildWgtPackage, ensureWidgetBinaryAssets } from '../scripts/build-wgt.ts';
import {
  transpileTsToTizenBrowserJs,
  transpileTsToTizenServiceJs
} from '../scripts/transpile-tizen.ts';
import { validateProjectConfig } from '../scripts/validate-config.ts';
import * as AppIPCBridge from '../src/app-ipc-bridge.ts';
import * as ManifestLoader from '../src/manifest-loader.ts';
import type {
  ManifestDocumentLike,
  ManifestElementLike,
  XMLHttpRequestConstructorLike,
  XMLHttpRequestLike
} from '../src/manifest-loader.ts';
import * as requestHelper from '../src/service/request.ts';
import samplePreview from '../src/service/sample.json' with { type: 'json' };
import * as TizenService from '../src/service/service.ts';
import type {
  SmartHubPreviewPayload,
  TizenApplicationControl,
  TizenApplicationControlData,
  TizenKeyValueMessage,
  TizenNamespace,
  WebApisNamespace
} from '../src/types/tizen.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RawHttpResponse {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
  readonly buffer: Buffer;
}

interface RawHttpOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

function httpRequestRaw(url: string, options?: RawHttpOptions): Promise<RawHttpResponse> {
  return new Promise<RawHttpResponse>((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options?.method ?? 'GET',
        headers: options?.headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: buffer.toString('utf8'),
            buffer
          });
        });
      }
    );
    req.on('error', reject);
    if (options && options.body !== undefined) {
      req.write(
        typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
      );
    }
    req.end();
  });
}

function sha256Hex(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

void test('1. Project configuration validation passes and negative control catches regressions', () => {
  const validResult = validateProjectConfig(path.resolve(__dirname, '..'));
  assert.equal(
    validResult.valid,
    true,
    'Expected repository configuration to pass validation'
  );
  assert.equal(validResult.errors.length, 0);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-webtv-neg-'));
  fs.mkdirSync(path.join(tmpDir, 'src/service'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'src/config.xml'),
    `<widget>
      <tizen:application id="PkgA.AppOne" package="PkgA"/>
      <tizen:service id="PkgA.service"/>
      <tizen:metadata key="http://samsung.com/tv/metadata/use.preview" value="\tbg_service"/>
    </widget>`
  );
  fs.writeFileSync(
    path.join(tmpDir, 'src/service/config.json'),
    JSON.stringify({
      clientAppId: 'PkgA.MismatchedApp',
      previewServiceId: 'PkgA.service'
    })
  );

  const invalidResult = validateProjectConfig(tmpDir);
  assert.equal(
    invalidResult.valid,
    false,
    'Negative control must fail on invalid fixture'
  );
  assert.ok(
    invalidResult.errors.some((e) => e.includes('App ID mismatch')),
    'Must report App ID mismatch'
  );
  assert.ok(
    invalidResult.errors.some((e) => e.includes('leading tab')),
    'Must report leading tab in bg_service metadata'
  );
});

void test('2. ManifestLoader injects CSS into <head> and JS bundles into <body> in strict order', () => {
  const headNodes: ManifestElementLike[] = [];
  const bodyNodes: ManifestElementLike[] = [];

  const mockHead: ManifestElementLike = {
    appendChild: (el: ManifestElementLike): void => {
      headNodes.push(el);
    }
  };
  const mockBody: ManifestElementLike = {
    appendChild: (el: ManifestElementLike): void => {
      bodyNodes.push(el);
    }
  };
  const mockDoc: ManifestDocumentLike = {
    documentElement: mockBody,
    body: mockBody,
    getElementsByTagName: (tag: string): ArrayLike<ManifestElementLike> =>
      tag === 'head' ? [mockHead] : [],
    createElement: (_tag: string): ManifestElementLike => ({
      appendChild: (): void => {}
    })
  };

  const manifest: Record<string, string> = {
    'styles.css': '/assets/styles.css',
    'app.js': '/assets/app.js',
    'core.js': '/assets/core.js',
    'player.js': '/assets/player.js'
  };

  const injected = ManifestLoader.injectManifestAssets(
    manifest,
    { manifestDomain: 'https://cdn.example.org' },
    mockDoc
  );

  assert.deepEqual(injected.css, ['https://cdn.example.org/assets/styles.css']);
  assert.deepEqual(injected.js, [
    'https://cdn.example.org/assets/core.js',
    'https://cdn.example.org/assets/player.js',
    'https://cdn.example.org/assets/app.js'
  ]);
  assert.equal(headNodes.length, 1);
  assert.equal(headNodes[0]?.rel, 'stylesheet');
  assert.equal(bodyNodes.length, 3);
  assert.equal(bodyNodes[0]?.src, 'https://cdn.example.org/assets/core.js');
  assert.equal(bodyNodes[0]?.async, false);
  assert.equal(bodyNodes[1]?.async, false);
  assert.equal(bodyNodes[2]?.src, 'https://cdn.example.org/assets/app.js');
  assert.equal(bodyNodes[2]?.async, false);
});

void test('3. ManifestLoader retries on transient failure and invokes onError when retries exhausted', () => {
  let attempts = 0;

  class FailingXhr implements XMLHttpRequestLike {
    readyState = 0;
    status = 503;
    responseText = '';
    timeout = 0;
    onreadystatechange: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    open(_method: string, _url: string, _async: boolean): void {}
    send(): void {
      attempts += 1;
      this.readyState = 4;
      if (this.onreadystatechange) {
        this.onreadystatechange();
      }
    }
  }

  let capturedError: Error | null = null;
  ManifestLoader.loadManifest(
    {
      manifestDomain: 'http://127.0.0.1:4000',
      maxRetries: 2,
      retryDelayMs: 1,
      XMLHttpRequest: FailingXhr as unknown as XMLHttpRequestConstructorLike,
      setTimeout: (fn: () => void): unknown => {
        fn();
        return 0;
      }
    },
    {
      onError: (err: Error): void => {
        capturedError = err;
      }
    }
  );

  assert.equal(attempts, 3, 'Should attempt initial request + 2 retries');
  assert.ok(capturedError !== null);
  assert.match((capturedError as Error).message, /HTTP 503/);
});

void test('4. AppIPCBridge registers TV remote media keys and responds to SERVICE_ONLINE with SYNC_PREVIEW_FEED', () => {
  const registeredKeys: string[] = [];
  const sentMessages: Array<{
    serviceId: string;
    portName: string;
    msg: readonly TizenKeyValueMessage[];
  }> = [];
  let launchedServiceId: string | null = null;

  class MockAppControlData implements TizenApplicationControlData {
    readonly key: string;
    readonly value: readonly string[];
    constructor(key: string, value: readonly string[]) {
      this.key = key;
      this.value = value;
    }
  }

  class MockAppControl implements TizenApplicationControl {
    readonly operation: string;
    readonly data: readonly TizenApplicationControlData[];
    constructor(
      operation: string,
      _uri?: string | null,
      _mime?: string | null,
      _category?: string | null,
      data?: readonly TizenApplicationControlData[]
    ) {
      this.operation = operation;
      this.data = data ?? [];
    }
  }

  const mockTizen: TizenNamespace = {
    tvinputdevice: {
      registerKey: (k: string): void => {
        registeredKeys.push(k);
      }
    },
    messageport: {
      requestLocalMessagePort: () => ({
        addMessagePortListener: (): number => 1
      }),
      requestRemoteMessagePort: (serviceId: string, portName: string) => ({
        sendMessage: (msg: readonly TizenKeyValueMessage[]): void => {
          sentMessages.push({ serviceId, portName, msg });
        }
      })
    },
    ApplicationControl: MockAppControl,
    ApplicationControlData: MockAppControlData,
    application: {
      getCurrentApplication: () => ({
        exit: (): void => {},
        getRequestedAppControl: () => null
      }),
      launchAppControl: (
        _ctrl: TizenApplicationControl,
        serviceId: string | null,
        onSuccess?: () => void
      ): void => {
        launchedServiceId = serviceId;
        if (onSuccess) onSuccess();
      }
    }
  };

  const bridge = AppIPCBridge.createIPCBridge({
    tizen: mockTizen,
    previewFeedUrl: 'https://api.example.org/preview.json',
    logger: { info: (): void => {}, warn: (): void => {}, error: (): void => {} }
  });

  bridge.registerRemoteKeys();
  assert.ok(registeredKeys.includes('MediaPlayPause'));
  assert.ok(registeredKeys.includes('ColorF0Red'));

  bridge.initPreviewService();
  assert.equal(launchedServiceId, 'OSWebTVApp.service');

  bridge.onMessageReceived([{ key: 'SERVICE_ONLINE', value: true }]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.serviceId, 'OSWebTVApp.service');
  assert.equal(sentMessages[0]?.portName, 'WEBTV_SERVICE_CHANNEL');
  assert.deepEqual(sentMessages[0]?.msg, [
    { key: 'SYNC_PREVIEW_FEED', value: 'https://api.example.org/preview.json' }
  ]);
});

void test('5. Background Service completes full SYNC_PREVIEW_FEED lifecycle and handles errors cleanly', async () => {
  const logs: Array<{ msg: string; data: unknown }> = [];
  let previewPayloadSaved: SmartHubPreviewPayload | null = null;
  let serviceExited = false;
  let localListener:
    | ((data: readonly TizenKeyValueMessage[]) => void)
    | null = null;
  const remoteMessages: Array<readonly TizenKeyValueMessage[]> = [];

  const mockTizen: TizenNamespace = {
    messageport: {
      requestLocalMessagePort: () => ({
        addMessagePortListener: (
          fn: (data: readonly TizenKeyValueMessage[]) => void
        ): number => {
          localListener = fn;
          return 1;
        }
      }),
      requestRemoteMessagePort: () => ({
        sendMessage: (msg: readonly TizenKeyValueMessage[]): void => {
          remoteMessages.push(msg);
        }
      })
    },
    application: {
      launchAppControl: (): void => {},
      getCurrentApplication: () => ({
        exit: (): void => {
          serviceExited = true;
        },
        getRequestedAppControl: () => null
      })
    }
  };

  const mockWebapis: WebApisNamespace = {
    preview: {
      setPreviewData: (jsonStr: string, onSuccess?: () => void): void => {
        previewPayloadSaved = JSON.parse(jsonStr) as SmartHubPreviewPayload;
        if (onSuccess) onSuccess();
      }
    }
  };

  const service = TizenService.createService({
    tizen: mockTizen,
    webapis: mockWebapis,
    remoteLogger: {
      log: (msg: string, data?: unknown): void => {
        logs.push({ msg, data });
      }
    },
    httpClient: {
      get: async <T = unknown>(url: string): Promise<T> => {
        if (url === 'https://bad.example.org/fail') {
          throw new Error('Simulated network error');
        }
        return samplePreview as unknown as T;
      }
    }
  });

  service.onStart();
  assert.equal(remoteMessages.length, 1);
  assert.deepEqual(remoteMessages[0], [{ key: 'SERVICE_ONLINE', value: true }]);
  assert.equal(typeof localListener, 'function');

  await service.syncLauncherFeed('https://api.example.org/preview.json');
  assert.ok(previewPayloadSaved !== null);
  const saved = previewPayloadSaved as SmartHubPreviewPayload;
  assert.equal(saved.sections[0]?.title, 'Featured Open Streams');
  assert.equal(serviceExited, true);

  const failedData = await service.syncLauncherFeed('https://bad.example.org/fail');
  assert.equal(failedData, null);
  assert.ok(logs.some((entry) => entry.msg === 'Failed fetching launcher preview feed'));

  const rejected = service.publishLauncherTiles({ invalid: true });
  assert.equal(rejected, false);
});

void test('6. Filename metadata parser, SRT-to-VTT converter, and M3U parser extract accurate metadata', () => {
  const meta = parseMediaFilename(
    'Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.10bit.HDR.EAC3.mkv'
  );
  assert.equal(meta.title, 'Blade Runner 2049');
  assert.equal(meta.year, 2017);
  assert.equal(meta.resolution, '4K UHD');
  assert.equal(meta.videoCodec, 'HEVC');
  assert.equal(meta.audioCodec, 'EAC3 5.1');
  assert.equal(meta.isHdr, true);
  assert.equal(meta.prefersAvPlay, true);

  const epMeta = parseMediaFilename('Severance.S01E09.1080p.WEBRip.x264.AAC.mp4');
  assert.equal(epMeta.title, 'Severance');
  assert.equal(epMeta.episodeTag, 'S01E09');
  assert.equal(epMeta.resolution, '1080p');
  assert.equal(epMeta.videoCodec, 'H.264');
  assert.equal(epMeta.prefersAvPlay, false);

  const webTitleMeta = parseMediaFilename(
    "Charlotte's.Web.2006.1080p.WEB-DL.x264.AAC.mp4"
  );
  assert.equal(webTitleMeta.title, "Charlotte's Web");
  assert.equal(webTitleMeta.year, 2006);

  const bracketYearMeta = parseMediaFilename('The.Matrix.[1999].1080p.BluRay.mp4');
  assert.equal(bracketYearMeta.title, 'The Matrix');
  assert.equal(bracketYearMeta.year, 1999);

  const vtt = convertSrtToVtt(
    '\uFEFF1\r\n0:01:15,250 --> 00:01:18,900\r\nHello from SMB share!\r\n'
  );
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('0:01:15.250 --> 00:01:18.900'));

  const m3uText = `#EXTM3U
#EXTINF:-1 tvg-logo="http://example.org/logo.png" group-title="Sci-Fi",Sci-Fi Live 1080p
http://192.168.1.50:8080/live/scifi.m3u8
#EXTINF:-1 group-title="Movies",Retro Cinema Channel
http://192.168.1.50:8080/live/retro.m3u8`;

  const m3uItems = parseM3uPlaylist(m3uText, 'Home IPTV');
  assert.equal(m3uItems.length, 2);
  assert.equal(m3uItems[0]?.title, 'Sci-Fi Live 1080p');
  assert.equal(m3uItems[0]?.videoCodec, 'HLS');
  // Second M3U item without tvg-logo must receive its own unique media-<id>.svg poster & backdrop
  assert.match(m3uItems[1]?.image_url ?? '', /^\/assets\/posters\/media-m3u-/);
  assert.match(m3uItems[1]?.backdrop_url ?? '', /^\/assets\/backgrounds\/media-m3u-/);

  // Verify M3U & custom stream deduplication in MediaCatalogManager
  const mgr = createMediaCatalogManager();
  mgr.addM3uContent(m3uText, 'Home IPTV');
  mgr.addM3uContent(m3uText, 'Home IPTV');
  mgr.addCustomStream({ title: 'NAS Test Stream', streamUrl: 'http://192.168.1.10/a.mp4' });
  mgr.addCustomStream({ title: 'NAS Test Stream', streamUrl: 'http://192.168.1.10/a.mp4' });
  const allCatalog = mgr.getAllItems();
  const ids = allCatalog.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'Catalog item IDs must be 100% unique');
});

void test('7. Hybrid Video Player switches between Samsung AVPlay and HTML5 Video and resolves Deep-Links', () => {
  const mockTizenDeepLink: TizenNamespace = {
    application: {
      launchAppControl: (): void => {},
      getCurrentApplication: () => ({
        exit: (): void => {},
        getRequestedAppControl: () => ({
          appControl: {
            operation: 'http://tizen.org/appcontrol/operation/view',
            data: [
              {
                key: 'PAYLOAD',
                value: [JSON.stringify({ values: 'watch/file-abc123?t=95' })]
              }
            ]
          }
        })
      })
    }
  };

  const parsedLink = OpenWebTVPlayer.extractDeepLinkFromEnvironment(
    mockTizenDeepLink,
    ''
  );
  assert.deepEqual(parsedLink, {
    command: 'watch',
    itemId: 'file-abc123',
    resumeSec: 95
  });

  const avplayCalls: Array<readonly unknown[]> = [];
  const mockWebapis: WebApisNamespace = {
    avplay: {
      open: (u: string): void => {
        avplayCalls.push(['open', u]);
      },
      setDisplayRect: (): void => {
        avplayCalls.push(['setDisplayRect']);
      },
      setDisplayMethod: (): void => {
        avplayCalls.push(['setDisplayMethod']);
      },
      setListener: (): void => {
        avplayCalls.push(['setListener']);
      },
      getDuration: (): number => 7200000,
      getTotalTrackInfo: () => [
        { type: 'AUDIO', index: 0 },
        { type: 'AUDIO', index: 1 }
      ],
      setSelectTrack: (t: string, idx: number): void => {
        avplayCalls.push(['setSelectTrack', t, idx]);
      },
      seekTo: (ms: number): void => {
        avplayCalls.push(['seekTo', ms]);
      },
      jumpForward: (ms: number): void => {
        avplayCalls.push(['jumpForward', ms]);
      },
      jumpBackward: (ms: number): void => {
        avplayCalls.push(['jumpBackward', ms]);
      },
      prepare: (): void => {},
      prepareAsync: (onSuccess?: () => void): void => {
        if (onSuccess) onSuccess();
      },
      play: (): void => {
        avplayCalls.push(['play']);
      },
      pause: (): void => {
        avplayCalls.push(['pause']);
      },
      stop: (): void => {
        avplayCalls.push(['stop']);
      },
      close: (): void => {
        avplayCalls.push(['close']);
      }
    }
  };

  const player = OpenWebTVPlayer.createHybridPlayer({
    webapis: mockWebapis
  });

  const backend = player.load(
    {
      id: 'mkv-1',
      title: 'Dune',
      streamUrl: 'http://127.0.0.1:4000/stream/mkv-1',
      prefersAvPlay: true
    },
    { startTimeSec: 120 }
  );

  assert.equal(backend, 'avplay');
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.duration, 7200);
  assert.ok(avplayCalls.some((c) => c[0] === 'seekTo' && c[1] === 120000));

  player.seekRelative(30);
  assert.ok(avplayCalls.some((c) => c[0] === 'jumpForward' && c[1] === 30000));

  player.cycleAudioTrack();
  assert.ok(avplayCalls.some((c) => c[0] === 'setSelectTrack' && c[2] === 1));
});

void test('8. SMB directory scanner, HTTP 206 Byte-Range streaming, SRT subtitle conversion, and Continue Watching work end-to-end', async () => {
  const tmpMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-webtv-smb-'));
  const movieName = 'Interstellar.2014.2160p.UHD.x265.HDR.EAC3';
  const videoBytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'utf8');
  fs.writeFileSync(path.join(tmpMediaDir, `${movieName}.mkv`), videoBytes);
  fs.writeFileSync(
    path.join(tmpMediaDir, `${movieName}.srt`),
    '1\n00:00:01,000 --> 00:00:04,500\nDo not go gentle into that good night.\n'
  );
  fs.writeFileSync(
    path.join(tmpMediaDir, `${movieName}.nfo`),
    '<movie><title>Interstellar</title><year>2014</year><plot>Explorers travel through a wormhole in space.</plot></movie>'
  );

  const { server } = createDevServer({ silent: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const mountRes = await httpRequestRaw(`${baseUrl}/api/sources/smb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { path: tmpMediaDir, label: 'NAS Movies' }
    });
    assert.equal(mountRes.statusCode, 200);
    const mountData = JSON.parse(mountRes.body) as { items: CatalogItem[] };
    const smbMovie = mountData.items.find((i) => i.title === 'Interstellar');
    assert.ok(smbMovie, 'Expected scanned SMB MKV movie in catalog');
    assert.equal(smbMovie.resolution, '4K UHD');
    assert.equal(smbMovie.videoCodec, 'HEVC');
    assert.equal(smbMovie.hasSubtitles, true);
    assert.equal(smbMovie.description, 'Explorers travel through a wormhole in space.');

    const rangeRes = await httpRequestRaw(`${baseUrl}/stream/${smbMovie.id}`, {
      method: 'GET',
      headers: { Range: 'bytes=10-19' }
    });
    assert.equal(rangeRes.statusCode, 206);
    assert.equal(rangeRes.headers['content-range'], `bytes 10-19/${videoBytes.length}`);
    assert.equal(rangeRes.body, 'ABCDEFGHIJ');

    // Verify RFC 7233 suffix-byte-range-spec (bytes=-6 requests final 6 bytes)
    const suffixRangeRes = await httpRequestRaw(`${baseUrl}/stream/${smbMovie.id}`, {
      method: 'GET',
      headers: { Range: 'bytes=-6' }
    });
    assert.equal(suffixRangeRes.statusCode, 206);
    assert.equal(
      suffixRangeRes.headers['content-range'],
      `bytes ${videoBytes.length - 6}-${videoBytes.length - 1}/${videoBytes.length}`
    );
    assert.equal(suffixRangeRes.body, 'UVWXYZ');

    // Verify invalid empty range (bytes=-) returns 416 Range Not Satisfiable
    const emptyRangeRes = await httpRequestRaw(`${baseUrl}/stream/${smbMovie.id}`, {
      method: 'GET',
      headers: { Range: 'bytes=-' }
    });
    assert.equal(emptyRangeRes.statusCode, 416);

    const subRes = await httpRequestRaw(`${baseUrl}/subtitles/${smbMovie.id}.vtt`);
    assert.equal(subRes.statusCode, 200);
    assert.match(String(subRes.headers['content-type']), /text\/vtt/);
    assert.ok(subRes.body.startsWith('WEBVTT'));
    assert.ok(subRes.body.includes('00:00:01.000 --> 00:00:04.500'));

    const progRes = await httpRequestRaw(`${baseUrl}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { itemId: smbMovie.id, positionSec: 1800, durationSec: 3600 }
    });
    assert.equal(progRes.statusCode, 200);

    const previewData = await requestHelper.get<SmartHubPreviewPayload>(
      `${baseUrl}/preview.json`
    );
    assert.equal(previewData.sections[0]?.title, 'Continue Watching');
    assert.match(previewData.sections[0]?.tiles[0]?.title ?? '', /Interstellar \(50%\)/);
    assert.equal(
      previewData.sections[0]?.tiles[0]?.action_data,
      `watch/${smbMovie.id}?t=1800`
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('9. All binary and vector assets (logo, background, posters, stage backdrops) are 100% unique', () => {
  const rootDir = path.resolve(__dirname, '..');
  const srcDir = path.join(rootDir, 'src');
  const { logoPath, backgroundPath } = ensureWidgetBinaryAssets(srcDir);

  const logoBuf = fs.readFileSync(logoPath);
  const bgBuf = fs.readFileSync(backgroundPath);

  // Verify valid PNG magic header
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(logoBuf.subarray(0, 8), pngSig);
  assert.deepEqual(bgBuf.subarray(0, 8), pngSig);
  assert.notEqual(sha256Hex(logoBuf), sha256Hex(bgBuf));

  // Verify ambient background SVG
  const ambientSvg = renderAmbientBackgroundSvg();
  assert.ok(ambientSvg.includes('viewBox="0 0 1920 1080"'));
  assert.ok(ambientSvg.includes('aurora-cyan'));

  // Verify every built-in stream has a unique poster SVG and unique backdrop SVG
  const builtIn = getBuiltInOpenStreams();
  const posterHashes = new Set<string>();
  const backdropHashes = new Set<string>();

  for (const item of builtIn) {
    const posterSlug = path.basename(item.image_url, '.svg');
    const backdropSlug = path.basename(item.backdrop_url, '.svg');
    const posterSvg = renderPosterSvg(posterSlug, item);
    const backdropSvg = renderBackdropSvg(backdropSlug, item);

    posterHashes.add(sha256Hex(posterSvg));
    backdropHashes.add(sha256Hex(backdropSvg));
  }
  assert.equal(
    posterHashes.size,
    builtIn.length,
    'Every built-in stream must have a unique poster SVG'
  );
  assert.equal(
    backdropHashes.size,
    builtIn.length,
    'Every built-in stream must have a unique stage backdrop SVG'
  );

  // Verify dynamically added custom/SMB streams each produce distinct deterministic SVG backgrounds
  const customA: CatalogItem = {
    ...builtIn[0]!,
    id: 'file-alpha111',
    title: 'Arrival',
    streamUrl: '/stream/file-alpha111'
  };
  const customB: CatalogItem = {
    ...builtIn[0]!,
    id: 'file-bravo222',
    title: 'Solaris',
    streamUrl: '/stream/file-bravo222'
  };

  const posterA = renderPosterSvg('media-file-alpha111', customA);
  const posterB = renderPosterSvg('media-file-bravo222', customB);
  const backdropA = renderBackdropSvg('media-file-alpha111', customA);
  const backdropB = renderBackdropSvg('media-file-bravo222', customB);

  assert.notEqual(sha256Hex(posterA), sha256Hex(posterB));
  assert.notEqual(sha256Hex(backdropA), sha256Hex(backdropB));
  assert.notEqual(sha256Hex(createLogoPngBuffer()), sha256Hex(createBackgroundPngBuffer()));
});

void test('10. TypeScript-to-Tizen JS transpilation and .wgt packaging produce valid Tizen widget & HTTP bundles', async () => {
  const rootDir = path.resolve(__dirname, '..');
  const wgtPath = buildWgtPackage(rootDir);
  assert.ok(fs.existsSync(wgtPath), 'Expected dist/OpenWebTV.wgt to be created');

  const zipListing = execFileSync('unzip', ['-l', wgtPath], { encoding: 'utf8' });
  for (const expectedArchiveEntry of [
    'config.xml',
    'index.html',
    'logo.png',
    'background.png',
    'app-ipc-bridge.js',
    'manifest-loader.js',
    'service/service.js',
    'service/request.js',
    'service/remoteLogger.js',
    'service/config.json',
    'service/sample.json'
  ]) {
    assert.ok(
      zipListing.includes(expectedArchiveEntry),
      `Expected OpenWebTV.wgt to include ${expectedArchiveEntry}`
    );
  }

  // 1. Actually load and execute the transpiled CommonJS service/service.js via Node createRequire
  const requireCjs = createRequire(import.meta.url);
  const compiledServicePath = path.join(rootDir, 'dist/wgt-staging/service/service.js');
  const compiledServiceMod = requireCjs(compiledServicePath) as typeof TizenService;
  assert.equal(typeof compiledServiceMod.createService, 'function');
  assert.equal(typeof compiledServiceMod.onStart, 'function');
  assert.equal(typeof compiledServiceMod.validatePreviewPayload, 'function');
  assert.equal(compiledServiceMod.validatePreviewPayload(samplePreview), true);
  assert.equal(compiledServiceMod.validatePreviewPayload({ sections: [] }), false);

  const cjsLogs: string[] = [];
  const cjsSvcInstance = compiledServiceMod.createService({
    tizen: null,
    webapis: null,
    remoteLogger: {
      log: (msg: string): void => {
        cjsLogs.push(msg);
      }
    }
  });
  cjsSvcInstance.onStart();
  cjsSvcInstance.onExit();
  assert.ok(cjsLogs.includes('Service onStart'));
  assert.ok(cjsLogs.includes('Service onExit'));

  // 2. Enforce strict ES5 syntax gate across all 8 emitted Tizen JS bundles
  const emittedJsFiles = [
    'dist/wgt-staging/app-ipc-bridge.js',
    'dist/wgt-staging/manifest-loader.js',
    'dist/wgt-staging/service/service.js',
    'dist/wgt-staging/service/request.js',
    'dist/wgt-staging/service/remoteLogger.js',
    'dist/public/core.js',
    'dist/public/player.js',
    'dist/public/app.js'
  ];

  for (const relPath of emittedJsFiles) {
    const fullPath = path.join(rootDir, relPath);
    const jsCode = fs.readFileSync(fullPath, 'utf8');
    const codeWithoutComments = jsCode.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

    assert.equal(
      /\?\./.test(codeWithoutComments),
      false,
      `${relPath} must not contain ES2020 optional chaining (?.)`
    );
    assert.equal(
      /\?\?/.test(codeWithoutComments),
      false,
      `${relPath} must not contain ES2020 nullish coalescing (??)`
    );
    assert.equal(
      /=>/.test(codeWithoutComments),
      false,
      `${relPath} must not contain ES6 arrow functions (=>)`
    );
    assert.equal(
      /\b(const|let)\b/.test(codeWithoutComments),
      false,
      `${relPath} must not contain ES6 const/let declarations`
    );
    assert.equal(
      /`/.test(codeWithoutComments),
      false,
      `${relPath} must not contain ES6 template literals`
    );
    assert.equal(
      /\b(import|export)\b/.test(codeWithoutComments),
      false,
      `${relPath} must not contain untranspiled ES module import/export keywords`
    );
  }

  // 3. Execute transpiled browser IIFE bundles inside a VM sandbox
  const sandboxWindow: Record<string, unknown> = {
    OPEN_WEBTV_DISABLE_AUTOBOOT: true,
    addEventListener: (): void => {}
  };
  const vmContext = vm.createContext({
    window: sandboxWindow,
    document: {
      readyState: 'complete',
      addEventListener: (): void => {},
      getElementById: (): null => null
    },
    console,
    setTimeout,
    clearTimeout
  });

  for (const browserBundle of [
    'dist/wgt-staging/app-ipc-bridge.js',
    'dist/wgt-staging/manifest-loader.js',
    'dist/public/core.js',
    'dist/public/player.js'
  ]) {
    const code = fs.readFileSync(path.join(rootDir, browserBundle), 'utf8');
    vm.runInContext(code, vmContext, { filename: browserBundle });
  }

  assert.ok(sandboxWindow.AppIPCBridge, 'VM must attach window.AppIPCBridge');
  assert.ok(sandboxWindow.ManifestLoader, 'VM must attach window.ManifestLoader');
  assert.ok(
    sandboxWindow.__OPEN_WEBTV_RUNTIME__,
    'VM must attach window.__OPEN_WEBTV_RUNTIME__'
  );
  assert.ok(sandboxWindow.OpenWebTVPlayer, 'VM must attach window.OpenWebTVPlayer');

  // 4. Test transpiler downleveling of ES2020+/TypeScript edge cases directly
  const complexTsSample = `
    import type { ServiceConfig } from '../src/types/tizen.ts';
    import {
      get as httpGet,
      type RequestOptions
    } from './request.ts';
    export interface SampleBox {
      readonly label?: string;
    }
    export const computeGreeting = (box?: SampleBox | null): string => {
      const label = box?.label ?? 'Default';
      const merged = Object.assign({}, { tag: \`[\${label}]\` });
      return merged.tag;
    };
    export {
      type SampleBox,
      httpGet
    };
  `;
  const transpiledCjs = transpileTsToTizenServiceJs(complexTsSample);
  assert.ok(!transpiledCjs.includes('?.'));
  assert.ok(!transpiledCjs.includes('??'));
  assert.ok(!transpiledCjs.includes('=>'));
  assert.ok(!/\b(const|let)\b/.test(transpiledCjs));
  assert.ok(transpiledCjs.includes('__assign'));
  assert.ok(transpiledCjs.includes('computeGreeting: computeGreeting'));
  assert.ok(transpiledCjs.includes('httpGet: httpGet'));

  const transpiledBrowser = transpileTsToTizenBrowserJs(complexTsSample);
  assert.ok(transpiledBrowser.startsWith('(function () {'));
  assert.ok(!transpiledBrowser.includes('?.'));

  // 5. Verify UI security & widget-origin helpers (escapeHtml, cloneCatalogItem, resolveServerUrl)
  assert.equal(
    escapeHtml('<script>alert("xss" & \'test\')</script>'),
    '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;test&#39;)&lt;/script&gt;'
  );
  assert.equal(
    resolveServerUrl('/api/catalog', 'http://192.168.1.50:4000/'),
    'http://192.168.1.50:4000/api/catalog'
  );
  const sampleItem = getBuiltInOpenStreams()[0]!;
  const cloned = cloneCatalogItem(sampleItem, { isFavorite: true });
  assert.equal(cloned.id, sampleItem.id);
  assert.equal(cloned.isFavorite, true);

  // 6. Verify dev-server serves transpiled JS for /app-ipc-bridge.js, /manifest-loader.js, /assets/player.js, /assets/app.js
  const { server } = createDevServer({ silent: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const jsRoute of [
      '/app-ipc-bridge.js',
      '/manifest-loader.js',
      '/assets/core.js',
      '/assets/player.js',
      '/assets/app.js'
    ]) {
      const res = await httpRequestRaw(`${baseUrl}${jsRoute}`);
      assert.equal(res.statusCode, 200, `Route ${jsRoute} must return HTTP 200`);
      assert.match(String(res.headers['content-type']), /application\/javascript/);
      assert.ok(
        !res.body.includes('import type'),
        `${jsRoute} must have all TypeScript syntax stripped`
      );
      assert.ok(
        !res.body.includes('?.'),
        `${jsRoute} must not contain ES2020 optional chaining`
      );
    }

    const bgSvgRes = await httpRequestRaw(`${baseUrl}/assets/background.svg`);
    assert.equal(bgSvgRes.statusCode, 200);
    assert.match(String(bgSvgRes.headers['content-type']), /image\/svg\+xml/);

    const backdropSvgRes = await httpRequestRaw(
      `${baseUrl}/assets/backgrounds/sintel.svg`
    );
    assert.equal(backdropSvgRes.statusCode, 200);
    assert.match(String(backdropSvgRes.headers['content-type']), /image\/svg\+xml/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
