/**
 * Open WebTV - Strictly Typed Dynamic Remote Bundle Bootloader
 *
 * Fetches `manifest.json` from a configurable media server and dynamically injects
 * CSS stylesheets (`styles.css`) and ordered JavaScript bundles (`core.js`, `player.js`, `app.js`)
 * into the DOM so the WebTV UI can be updated without re-packaging the Tizen `.wgt`.
 */

import type { IPCBridgeInstance, IPCBridgeOptions } from './app-ipc-bridge.ts';

export interface ManifestElementLike {
  rel?: string;
  type?: string;
  href?: string;
  src?: string;
  className?: string;
  textContent?: string | null;
  style?: { display?: string };
  onclick?: (() => void) | null;
  focus?: () => void;
  appendChild(child: ManifestElementLike): void;
}

export interface ManifestDocumentLike {
  readonly readyState?: string;
  readonly documentElement: ManifestElementLike;
  readonly body: ManifestElementLike | null;
  getElementsByTagName(tagName: string): ArrayLike<ManifestElementLike>;
  createElement(tagName: string): ManifestElementLike;
  getElementById?(id: string): ManifestElementLike | null;
  addEventListener?(
    type: string,
    listener: (event: { keyCode?: number; preventDefault?: () => void }) => void
  ): void;
}

export interface XMLHttpRequestLike {
  readyState: number;
  status: number;
  responseText: string;
  timeout?: number;
  onreadystatechange: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  open(method: string, url: string, async: boolean): void;
  send(): void;
}

export type XMLHttpRequestConstructorLike = new () => XMLHttpRequestLike;

export type SetTimeoutLike = (callback: () => void, ms: number) => unknown;

export interface ManifestLoaderOptions {
  manifestDomain?: string;
  manifestPath?: string;
  cssKey?: string;
  jsKeyOrder?: readonly string[];
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  document?: ManifestDocumentLike | null;
  XMLHttpRequest?: XMLHttpRequestConstructorLike | null;
  setTimeout?: SetTimeoutLike | null;
}

export interface ResolvedManifestOptions {
  manifestDomain: string;
  manifestPath: string;
  cssKey: string;
  jsKeyOrder: readonly string[];
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  document: ManifestDocumentLike | null;
  XMLHttpRequest: XMLHttpRequestConstructorLike | null;
  setTimeout: SetTimeoutLike | null;
}

export type ManifestAssetMap = Readonly<Record<string, string>>;

export interface InjectedAssetsResult {
  readonly css: string[];
  readonly js: string[];
}

export interface ManifestLoadCallbacks {
  onStatus?: (statusMessage: string) => void;
  onSuccess?: (manifestData: ManifestAssetMap, injected: InjectedAssetsResult) => void;
  onError?: (error: Error) => void;
}

export interface BootScreenController {
  setStatus(text: string): void;
  showError(errText: string): void;
  hideBootScreen(): void;
}

export var DEFAULT_OPTIONS: ResolvedManifestOptions = {
  manifestDomain: 'http://127.0.0.1:4000',
  manifestPath: '/manifest.json',
  cssKey: 'styles.css',
  jsKeyOrder: ['core.js', 'player.js', 'app.js'],
  maxRetries: 2,
  retryDelayMs: 1200,
  timeoutMs: 8000,
  document: null,
  XMLHttpRequest: null,
  setTimeout: null
};

export function mergeOptions(userOptions?: ManifestLoaderOptions): ResolvedManifestOptions {
  var u: ManifestLoaderOptions = userOptions || {};
  return {
    manifestDomain:
      u.manifestDomain !== undefined ? u.manifestDomain : DEFAULT_OPTIONS.manifestDomain,
    manifestPath:
      u.manifestPath !== undefined ? u.manifestPath : DEFAULT_OPTIONS.manifestPath,
    cssKey: u.cssKey !== undefined ? u.cssKey : DEFAULT_OPTIONS.cssKey,
    jsKeyOrder: u.jsKeyOrder !== undefined ? u.jsKeyOrder : DEFAULT_OPTIONS.jsKeyOrder,
    maxRetries: u.maxRetries !== undefined ? u.maxRetries : DEFAULT_OPTIONS.maxRetries,
    retryDelayMs:
      u.retryDelayMs !== undefined ? u.retryDelayMs : DEFAULT_OPTIONS.retryDelayMs,
    timeoutMs: u.timeoutMs !== undefined ? u.timeoutMs : DEFAULT_OPTIONS.timeoutMs,
    document: u.document !== undefined ? u.document : DEFAULT_OPTIONS.document,
    XMLHttpRequest:
      u.XMLHttpRequest !== undefined ? u.XMLHttpRequest : DEFAULT_OPTIONS.XMLHttpRequest,
    setTimeout: u.setTimeout !== undefined ? u.setTimeout : DEFAULT_OPTIONS.setTimeout
  };
}

export function resolveUrl(baseDomain: string, assetPath: string): string {
  if (!assetPath) {
    return '';
  }
  if (/^https?:\/\//i.test(assetPath) || assetPath.indexOf('//') === 0) {
    return assetPath;
  }
  var cleanBase: string = String(baseDomain || '').replace(/\/+$/, '');
  var cleanPath: string =
    String(assetPath).charAt(0) === '/' ? assetPath : '/' + assetPath;
  return cleanBase + cleanPath;
}

export function injectManifestAssets(
  manifestData: ManifestAssetMap,
  options?: ManifestLoaderOptions,
  doc?: ManifestDocumentLike | null
): InjectedAssetsResult {
  var defaultDoc: ManifestDocumentLike | null =
    typeof document !== 'undefined' ? (document as unknown as ManifestDocumentLike) : null;
  var opts: ResolvedManifestOptions = mergeOptions(options);
  var targetDoc: ManifestDocumentLike | null = doc || opts.document || defaultDoc;

  if (!targetDoc || !manifestData || typeof manifestData !== 'object') {
    throw new Error('Invalid manifest payload or document reference');
  }

  var injected: InjectedAssetsResult = {
    css: [],
    js: []
  };

  var headList = targetDoc.getElementsByTagName('head');
  var head: ManifestElementLike = headList[0] || targetDoc.documentElement;
  var body: ManifestElementLike = targetDoc.body || targetDoc.documentElement;

  var cssHref: string | undefined = manifestData[opts.cssKey];
  if (cssHref) {
    var resolvedCss: string = resolveUrl(opts.manifestDomain, cssHref);
    var link: ManifestElementLike = targetDoc.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = resolvedCss;
    head.appendChild(link);
    injected.css.push(resolvedCss);
  }

  var keyOrder: readonly string[] = opts.jsKeyOrder || [];
  for (var i = 0; i < keyOrder.length; i++) {
    var key: string | undefined = keyOrder[i];
    if (!key) continue;
    var scriptSrc: string | undefined = manifestData[key];
    if (scriptSrc) {
      var resolvedJs: string = resolveUrl(opts.manifestDomain, scriptSrc);
      var scriptTag: ManifestElementLike = targetDoc.createElement('script');
      scriptTag.type = 'text/javascript';
      scriptTag.src = resolvedJs;
      body.appendChild(scriptTag);
      injected.js.push(resolvedJs);
    }
  }

  return injected;
}

export function loadManifest(
  options?: ManifestLoaderOptions,
  callbacks?: ManifestLoadCallbacks
): void {
  var opts: ResolvedManifestOptions = mergeOptions(options);
  var cbs: ManifestLoadCallbacks = callbacks || {};
  var globalXhr: XMLHttpRequestConstructorLike | null =
    typeof XMLHttpRequest !== 'undefined'
      ? (XMLHttpRequest as unknown as XMLHttpRequestConstructorLike)
      : null;
  var XhrConstructor: XMLHttpRequestConstructorLike | null =
    opts.XMLHttpRequest || globalXhr;
  var setTimer: SetTimeoutLike = opts.setTimeout || setTimeout;

  if (!XhrConstructor) {
    if (cbs.onError) {
      cbs.onError(new Error('XMLHttpRequest is not available in this environment'));
    }
    return;
  }

  var manifestUrl: string = resolveUrl(opts.manifestDomain, opts.manifestPath);
  var attempt = 0;

  function executeAttempt(): void {
    if (!XhrConstructor) return;
    attempt += 1;
    if (cbs.onStatus) {
      cbs.onStatus(
        attempt === 1
          ? 'Loading application manifest...'
          : 'Retrying manifest connection (attempt ' +
              attempt +
              ' of ' +
              (opts.maxRetries + 1) +
              ')...'
      );
    }

    var xhr: XMLHttpRequestLike = new XhrConstructor();
    var settled = false;

    function handleFailure(reason: string): void {
      if (settled) {
        return;
      }
      settled = true;
      if (attempt <= opts.maxRetries) {
        var delay: number = opts.retryDelayMs * attempt;
        setTimer(executeAttempt, delay);
      } else if (cbs.onError) {
        cbs.onError(new Error(reason || 'Failed to load manifest from ' + manifestUrl));
      }
    }

    xhr.onreadystatechange = function (): void {
      if (xhr.readyState === 4) {
        if (settled) {
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var parsed = JSON.parse(xhr.responseText) as ManifestAssetMap;
            settled = true;
            var result = injectManifestAssets(parsed, opts, opts.document);
            if (cbs.onSuccess) {
              cbs.onSuccess(parsed, result);
            }
          } catch (parseErr: unknown) {
            var errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            handleFailure('Invalid JSON in manifest: ' + errMsg);
          }
        } else {
          handleFailure('HTTP ' + xhr.status + ' loading ' + manifestUrl);
        }
      }
    };

    xhr.onerror = function (): void {
      handleFailure('Network error loading ' + manifestUrl);
    };

    xhr.ontimeout = function (): void {
      handleFailure('Timeout loading ' + manifestUrl);
    };

    xhr.open('GET', manifestUrl, true);
    if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
      try {
        xhr.timeout = opts.timeoutMs;
      } catch (_e: unknown) {}
    }
    xhr.send();
  }

  executeAttempt();
}

export function setupBootScreenController(
  doc?: ManifestDocumentLike | null,
  onRetry?: () => void,
  onExit?: () => void
): BootScreenController | null {
  var defaultDoc: ManifestDocumentLike | null =
    typeof document !== 'undefined' ? (document as unknown as ManifestDocumentLike) : null;
  var targetDoc: ManifestDocumentLike | null = doc || defaultDoc;
  if (!targetDoc || !targetDoc.getElementById) {
    return null;
  }

  var bootScreen = targetDoc.getElementById('boot-screen');
  var bootStatus = targetDoc.getElementById('boot-status');
  var bootSpinner = targetDoc.getElementById('boot-spinner');
  var fallbackPanel = targetDoc.getElementById('fallback-panel');
  var fallbackMessage = targetDoc.getElementById('fallback-message');
  var btnRetry = targetDoc.getElementById('btn-retry');
  var btnExit = targetDoc.getElementById('btn-exit');
  var focusedIndex = 0;
  var buttons: Array<ManifestElementLike | null> = [btnRetry, btnExit];

  function updateFocus(idx: number): void {
    focusedIndex = idx;
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (!btn) continue;
      if (i === focusedIndex) {
        btn.className = 'tv-btn focused';
        if (btn.focus) btn.focus();
      } else {
        btn.className = 'tv-btn';
      }
    }
  }

  if (btnRetry) {
    btnRetry.onclick = function (): void {
      if (onRetry) onRetry();
    };
  }

  if (btnExit) {
    btnExit.onclick = function (): void {
      if (onExit) onExit();
    };
  }

  if (targetDoc.addEventListener) {
    targetDoc.addEventListener('keydown', function (e): void {
      if (!fallbackPanel || fallbackPanel.className?.indexOf('visible') === -1) {
        return;
      }
      if (e.keyCode === 37 || e.keyCode === 38) {
        updateFocus(0);
        if (e.preventDefault) e.preventDefault();
      } else if (e.keyCode === 39 || e.keyCode === 40) {
        updateFocus(1);
        if (e.preventDefault) e.preventDefault();
      } else if (e.keyCode === 13) {
        var activeBtn = buttons[focusedIndex];
        if (activeBtn && activeBtn.onclick) {
          activeBtn.onclick();
        }
        if (e.preventDefault) e.preventDefault();
      } else if (e.keyCode === 10009 || e.keyCode === 27) {
        if (onExit) onExit();
      }
    });
  }

  return {
    setStatus: function (text: string): void {
      if (bootStatus) bootStatus.textContent = text;
      if (bootSpinner && bootSpinner.style) bootSpinner.style.display = 'block';
      if (fallbackPanel) fallbackPanel.className = 'fallback-panel';
    },
    showError: function (errText: string): void {
      if (bootStatus) bootStatus.textContent = 'Connection Error';
      if (bootSpinner && bootSpinner.style) bootSpinner.style.display = 'none';
      if (fallbackMessage && errText) fallbackMessage.textContent = errText;
      if (fallbackPanel) fallbackPanel.className = 'fallback-panel visible';
      updateFocus(0);
    },
    hideBootScreen: function (): void {
      if (bootScreen) bootScreen.className = 'boot-screen hidden';
    }
  };
}

export function boot(customOptions?: ManifestLoaderOptions): void {
  var winRecord =
    typeof window !== 'undefined'
      ? (window as unknown as {
          OPEN_WEBTV_CONFIG?: ManifestLoaderOptions;
          AppIPCBridge?: {
            createIPCBridge?: (opts: IPCBridgeOptions) => IPCBridgeInstance;
          };
          location?: { protocol?: string; origin?: string };
        })
      : {};
  var globalConfig: ManifestLoaderOptions = winRecord.OPEN_WEBTV_CONFIG || {};
  var opts: ResolvedManifestOptions = mergeOptions(customOptions || globalConfig);

  if (
    !customOptions &&
    !globalConfig.manifestDomain &&
    winRecord.location &&
    winRecord.location.protocol &&
    /^https?:$/i.test(winRecord.location.protocol) &&
    winRecord.location.origin
  ) {
    opts.manifestDomain = winRecord.location.origin;
  }

  var ipcBridge: IPCBridgeInstance | null = null;
  if (winRecord.AppIPCBridge && winRecord.AppIPCBridge.createIPCBridge) {
    ipcBridge = winRecord.AppIPCBridge.createIPCBridge({
      previewFeedUrl: resolveUrl(opts.manifestDomain, '/preview.json')
    });
    ipcBridge.registerRemoteKeys();
    ipcBridge.initPreviewService();
  }

  var ui = setupBootScreenController(
    opts.document,
    function handleRetry(): void {
      startLoad();
    },
    function handleExit(): void {
      if (ipcBridge) {
        ipcBridge.exitApplication();
      }
    }
  );

  function startLoad(): void {
    loadManifest(opts, {
      onStatus: function (msg: string): void {
        if (ui) ui.setStatus(msg);
      },
      onSuccess: function (): void {
        if (ui) ui.hideBootScreen();
      },
      onError: function (err: Error): void {
        if (ui) ui.showError(err.message);
      }
    });
  }

  startLoad();
}

if (typeof window !== 'undefined') {
  var win = window as unknown as {
    ManifestLoader?: unknown;
    OPEN_WEBTV_DISABLE_AUTOBOOT?: boolean;
  };
  win.ManifestLoader = {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    mergeOptions: mergeOptions,
    resolveUrl: resolveUrl,
    injectManifestAssets: injectManifestAssets,
    loadManifest: loadManifest,
    setupBootScreenController: setupBootScreenController,
    boot: boot
  };
  if (typeof document !== 'undefined' && !win.OPEN_WEBTV_DISABLE_AUTOBOOT) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function (): void {
        boot();
      });
    } else {
      boot();
    }
  }
}
