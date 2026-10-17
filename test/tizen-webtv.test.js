/**
 * Open WebTV - Automated Unit & Integration Test Suite
 *
 * Covers:
 * 1. Configuration & cross-file ID synchronization (with negative control verification)
 * 2. Dynamic manifest loader (`src/manifest-loader.js`) asset ordering, retries, and error fallback
 * 3. Foreground Tizen IPC & remote key bridge (`src/app-ipc-bridge.js`)
 * 4. Background Smart Hub Preview service (`src/service/service.js`) & HTTP request helper
 * 5. Filename metadata parser, SRT-to-VTT subtitle converter, and M3U playlist parser
 * 6. Hybrid Video Player Engine (`AVPlay` hardware + `HTML5 <video>`) & Deep-Link (`appcontrol`) resolver
 * 7. SMB/Local directory mounting, HTTP `206 Partial Content` byte-range streaming, SRT-to-VTT endpoint,
 *    and Watch Progress (`Continue Watching` in `/preview.json`)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const { validateProjectConfig } = require('../scripts/validate-config');
const ManifestLoader = require('../src/manifest-loader');
const AppIPCBridge = require('../src/app-ipc-bridge');
const TizenService = require('../src/service/service');
const requestHelper = require('../src/service/request');
const { createDevServer } = require('../dev-server/index');
const {
  parseMediaFilename,
  convertSrtToVtt,
  parseM3uPlaylist
} = require('../dev-server/media-catalog');
const OpenWebTVPlayer = require('../dev-server/public/player');
const samplePreview = require('../src/service/sample.json');

function httpRequestRaw(url, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options || {}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: buffer.toString('utf8'),
          buffer
        });
      });
    });
    req.on('error', reject);
    if (options && options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('1. Project configuration validation passes and negative control catches regressions', () => {
  const validResult = validateProjectConfig(path.resolve(__dirname, '..'));
  assert.equal(validResult.valid, true, 'Expected repository configuration to pass validation');
  assert.equal(validResult.errors.length, 0);

  // Negative control: verify validator catches App ID mismatch and tab-contaminated metadata
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
    JSON.stringify({ clientAppId: 'PkgA.MismatchedApp', previewServiceId: 'PkgA.service' })
  );

  const invalidResult = validateProjectConfig(tmpDir);
  assert.equal(invalidResult.valid, false, 'Negative control must fail on invalid fixture');
  assert.ok(
    invalidResult.errors.some((e) => e.includes('App ID mismatch')),
    'Must report App ID mismatch'
  );
  assert.ok(
    invalidResult.errors.some((e) => e.includes('leading tab')),
    'Must report leading tab in bg_service metadata'
  );
});

test('2. ManifestLoader injects CSS into <head> and JS bundles into <body> in strict order', () => {
  const headNodes = [];
  const bodyNodes = [];
  const mockDoc = {
    getElementsByTagName: (tag) => (tag === 'head' ? [{ appendChild: (el) => headNodes.push(el) }] : []),
    body: { appendChild: (el) => bodyNodes.push(el) },
    createElement: (tag) => ({ tagName: tag.toUpperCase() })
  };

  const manifest = {
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
  assert.equal(headNodes[0].rel, 'stylesheet');
  assert.equal(bodyNodes.length, 3);
  assert.equal(bodyNodes[0].src, 'https://cdn.example.org/assets/core.js');
  assert.equal(bodyNodes[2].src, 'https://cdn.example.org/assets/app.js');
});

test('3. ManifestLoader retries on transient failure and invokes onError when retries exhausted', () => {
  let attempts = 0;
  function FailingXhr() {
    this.readyState = 0;
    this.status = 503;
  }
  FailingXhr.prototype.open = function () {};
  FailingXhr.prototype.send = function () {
    attempts += 1;
    this.readyState = 4;
    if (this.onreadystatechange) {
      this.onreadystatechange();
    }
  };

  let capturedError = null;
  ManifestLoader.loadManifest(
    {
      manifestDomain: 'http://127.0.0.1:4000',
      maxRetries: 2,
      retryDelayMs: 1,
      XMLHttpRequest: FailingXhr,
      setTimeout: (fn) => fn()
    },
    {
      onError: (err) => {
        capturedError = err;
      }
    }
  );

  assert.equal(attempts, 3, 'Should attempt initial request + 2 retries');
  assert.ok(capturedError instanceof Error);
  assert.match(capturedError.message, /HTTP 503/);
});

test('4. AppIPCBridge registers TV remote media keys and responds to SERVICE_ONLINE with SYNC_PREVIEW_FEED', () => {
  const registeredKeys = [];
  const sentMessages = [];
  let launchedServiceId = null;

  const mockTizen = {
    tvinputdevice: {
      registerKey: (k) => registeredKeys.push(k)
    },
    messageport: {
      requestLocalMessagePort: () => ({
        addMessagePortListener: () => {}
      }),
      requestRemoteMessagePort: (serviceId, portName) => ({
        sendMessage: (msg) => sentMessages.push({ serviceId, portName, msg })
      })
    },
    ApplicationControl: function () {},
    ApplicationControlData: function () {},
    application: {
      launchAppControl: (_ctrl, serviceId, onSuccess) => {
        launchedServiceId = serviceId;
        if (onSuccess) onSuccess();
      }
    }
  };

  const bridge = AppIPCBridge.createIPCBridge({
    tizen: mockTizen,
    previewFeedUrl: 'https://api.example.org/preview.json',
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });

  bridge.registerRemoteKeys();
  assert.ok(registeredKeys.includes('MediaPlayPause'));
  assert.ok(registeredKeys.includes('ColorF0Red'));

  bridge.initPreviewService();
  assert.equal(launchedServiceId, 'OSWebTVApp.service');

  // Simulate SERVICE_ONLINE message from background service
  bridge.onMessageReceived([{ key: 'SERVICE_ONLINE', value: true }]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].serviceId, 'OSWebTVApp.service');
  assert.equal(sentMessages[0].portName, 'WEBTV_SERVICE_CHANNEL');
  assert.deepEqual(sentMessages[0].msg, [
    { key: 'SYNC_PREVIEW_FEED', value: 'https://api.example.org/preview.json' }
  ]);
});

test('5. Background Service completes full SYNC_PREVIEW_FEED lifecycle and handles errors cleanly', async () => {
  const logs = [];
  let previewPayloadSaved = null;
  let serviceExited = false;
  let localListener = null;
  const remoteMessages = [];

  const mockTizen = {
    messageport: {
      requestLocalMessagePort: () => ({
        addMessagePortListener: (cb) => {
          localListener = cb;
        }
      }),
      requestRemoteMessagePort: () => ({
        sendMessage: (msg) => remoteMessages.push(msg)
      })
    },
    application: {
      getCurrentApplication: () => ({
        exit: () => {
          serviceExited = true;
        }
      })
    }
  };

  const mockWebapis = {
    preview: {
      setPreviewData: (jsonStr, onSuccess) => {
        previewPayloadSaved = JSON.parse(jsonStr);
        onSuccess();
      }
    }
  };

  const service = TizenService.createService({
    tizen: mockTizen,
    webapis: mockWebapis,
    remoteLogger: {
      log: (msg, data) => logs.push({ msg, data })
    },
    httpClient: {
      get: async (url) => {
        if (url === 'https://bad.example.org/fail') {
          throw new Error('Simulated network error');
        }
        return samplePreview;
      }
    }
  });

  service.onStart();
  assert.equal(remoteMessages.length, 1);
  assert.deepEqual(remoteMessages[0], [{ key: 'SERVICE_ONLINE', value: true }]);
  assert.equal(typeof localListener, 'function');

  await service.syncLauncherFeed('https://api.example.org/preview.json');
  assert.ok(previewPayloadSaved);
  assert.equal(previewPayloadSaved.sections[0].title, 'Featured Open Streams');
  assert.equal(serviceExited, true);

  const failedData = await service.syncLauncherFeed('https://bad.example.org/fail');
  assert.equal(failedData, null);
  assert.ok(logs.some((entry) => entry.msg === 'Failed fetching launcher preview feed'));

  const rejected = service.publishLauncherTiles({ invalid: true });
  assert.equal(rejected, false);
});

test('6. Filename metadata parser, SRT-to-VTT converter, and M3U parser extract accurate metadata', () => {
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

  const vtt = convertSrtToVtt(
    '1\r\n00:01:15,250 --> 00:01:18,900\r\nHello from SMB share!\r\n'
  );
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('00:01:15.250 --> 00:01:18.900'));

  const m3uItems = parseM3uPlaylist(
    `#EXTM3U
#EXTINF:-1 tvg-logo="http://example.org/logo.png" group-title="Sci-Fi",Sci-Fi Live 1080p
http://192.168.1.50:8080/live/scifi.m3u8`,
    'Home IPTV'
  );
  assert.equal(m3uItems.length, 1);
  assert.equal(m3uItems[0].title, 'Sci-Fi Live 1080p');
  assert.equal(m3uItems[0].videoCodec, 'HLS');
});

test('7. Hybrid Video Player switches between Samsung AVPlay and HTML5 Video and resolves Deep-Links', () => {
  const mockTizenDeepLink = {
    application: {
      getCurrentApplication: () => ({
        getRequestedAppControl: () => ({
          appControl: {
            data: [{ key: 'PAYLOAD', value: [JSON.stringify({ values: 'watch/file-abc123?t=95' })] }]
          }
        })
      })
    }
  };

  const parsedLink = OpenWebTVPlayer.extractDeepLinkFromEnvironment(mockTizenDeepLink, '');
  assert.deepEqual(parsedLink, {
    command: 'watch',
    itemId: 'file-abc123',
    resumeSec: 95
  });

  const avplayCalls = [];
  const mockWebapis = {
    avplay: {
      open: (u) => avplayCalls.push(['open', u]),
      setDisplayRect: () => avplayCalls.push(['setDisplayRect']),
      setDisplayMethod: () => avplayCalls.push(['setDisplayMethod']),
      setListener: () => avplayCalls.push(['setListener']),
      getDuration: () => 7200000,
      getTotalTrackInfo: () => [
        { type: 'AUDIO', index: 0 },
        { type: 'AUDIO', index: 1 }
      ],
      setSelectTrack: (t, idx) => avplayCalls.push(['setSelectTrack', t, idx]),
      seekTo: (ms) => avplayCalls.push(['seekTo', ms]),
      jumpForward: (ms) => avplayCalls.push(['jumpForward', ms]),
      prepareAsync: (onSuccess) => onSuccess(),
      play: () => avplayCalls.push(['play']),
      pause: () => avplayCalls.push(['pause']),
      stop: () => avplayCalls.push(['stop']),
      close: () => avplayCalls.push(['close'])
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

test('8. SMB directory scanner, HTTP 206 Byte-Range streaming, SRT subtitle conversion, and Continue Watching work end-to-end', async () => {
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const mountRes = await httpRequestRaw(`${baseUrl}/api/sources/smb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { path: tmpMediaDir, label: 'NAS Movies' }
    });
    assert.equal(mountRes.statusCode, 200);
    const mountData = JSON.parse(mountRes.body);
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

    const subRes = await httpRequestRaw(`${baseUrl}/subtitles/${smbMovie.id}.vtt`);
    assert.equal(subRes.statusCode, 200);
    assert.match(subRes.headers['content-type'], /text\/vtt/);
    assert.ok(subRes.body.startsWith('WEBVTT'));
    assert.ok(subRes.body.includes('00:00:01.000 --> 00:00:04.500'));

    const progRes = await httpRequestRaw(`${baseUrl}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { itemId: smbMovie.id, positionSec: 1800, durationSec: 3600 }
    });
    assert.equal(progRes.statusCode, 200);

    const previewData = await requestHelper.get(`${baseUrl}/preview.json`);
    assert.equal(previewData.sections[0].title, 'Continue Watching');
    assert.match(previewData.sections[0].tiles[0].title, /Interstellar \(50%\)/);
    assert.equal(previewData.sections[0].tiles[0].action_data, `watch/${smbMovie.id}?t=1800`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
