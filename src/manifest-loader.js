/**
 * Open WebTV - Dynamic Remote Bundle Bootloader
 *
 * Fetches `manifest.json` from a configurable media server and dynamically injects
 * CSS stylesheets (`styles.css`) and ordered JavaScript bundles (`core.js`, `player.js`, `app.js`)
 * into the DOM so the WebTV UI can be updated without re-packaging the Tizen `.wgt`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ManifestLoader = factory();
    if (typeof document !== 'undefined' && !root.OPEN_WEBTV_DISABLE_AUTOBOOT) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          root.ManifestLoader.boot();
        });
      } else {
        root.ManifestLoader.boot();
      }
    }
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_OPTIONS = {
    manifestDomain: 'http://127.0.0.1:4000',
    manifestPath: '/manifest.json',
    cssKey: 'styles.css',
    jsKeyOrder: ['core.js', 'player.js', 'app.js'],
    maxRetries: 2,
    retryDelayMs: 1200,
    timeoutMs: 8000
  };

  function mergeOptions(userOptions) {
    var opts = {};
    var k;
    for (k in DEFAULT_OPTIONS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, k)) {
        opts[k] = DEFAULT_OPTIONS[k];
      }
    }
    if (userOptions) {
      for (k in userOptions) {
        if (Object.prototype.hasOwnProperty.call(userOptions, k) && userOptions[k] !== undefined) {
          opts[k] = userOptions[k];
        }
      }
    }
    return opts;
  }

  function resolveUrl(baseDomain, assetPath) {
    if (!assetPath) {
      return '';
    }
    if (/^https?:\/\//i.test(assetPath) || assetPath.indexOf('//') === 0) {
      return assetPath;
    }
    var cleanBase = String(baseDomain || '').replace(/\/+$/, '');
    var cleanPath = String(assetPath).charAt(0) === '/' ? assetPath : '/' + assetPath;
    return cleanBase + cleanPath;
  }

  /**
   * Injects stylesheet and ordered script tags described by the parsed manifest object.
   */
  function injectManifestAssets(manifestData, options, doc) {
    var targetDoc = doc || (typeof document !== 'undefined' ? document : null);
    var opts = mergeOptions(options);
    if (!targetDoc || !manifestData || typeof manifestData !== 'object') {
      throw new Error('Invalid manifest payload or document reference');
    }

    var injected = {
      css: [],
      js: []
    };

    var head = targetDoc.getElementsByTagName('head')[0] || targetDoc.documentElement;
    var body = targetDoc.body || targetDoc.documentElement;

    var cssHref = manifestData[opts.cssKey];
    if (cssHref) {
      var resolvedCss = resolveUrl(opts.manifestDomain, cssHref);
      var link = targetDoc.createElement('link');
      link.rel = 'stylesheet';
      link.type = 'text/css';
      link.href = resolvedCss;
      head.appendChild(link);
      injected.css.push(resolvedCss);
    }

    var keyOrder = opts.jsKeyOrder || [];
    for (var i = 0; i < keyOrder.length; i++) {
      var key = keyOrder[i];
      var scriptSrc = manifestData[key];
      if (scriptSrc) {
        var resolvedJs = resolveUrl(opts.manifestDomain, scriptSrc);
        var scriptTag = targetDoc.createElement('script');
        scriptTag.type = 'text/javascript';
        scriptTag.src = resolvedJs;
        body.appendChild(scriptTag);
        injected.js.push(resolvedJs);
      }
    }

    return injected;
  }

  /**
   * Loads manifest.json via XMLHttpRequest with retry support.
   */
  function loadManifest(options, callbacks) {
    var opts = mergeOptions(options);
    var cbs = callbacks || {};
    var XhrConstructor = opts.XMLHttpRequest || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null);
    var setTimer = opts.setTimeout || setTimeout;

    if (!XhrConstructor) {
      if (cbs.onError) {
        cbs.onError(new Error('XMLHttpRequest is not available in this environment'));
      }
      return;
    }

    var manifestUrl = resolveUrl(opts.manifestDomain, opts.manifestPath);
    var attempt = 0;

    function executeAttempt() {
      attempt += 1;
      if (cbs.onStatus) {
        cbs.onStatus(
          attempt === 1
            ? 'Loading application manifest...'
            : 'Retrying manifest connection (attempt ' + attempt + ' of ' + (opts.maxRetries + 1) + ')...'
        );
      }

      var xhr = new XhrConstructor();
      var settled = false;

      function handleFailure(reason) {
        if (settled) {
          return;
        }
        settled = true;
        if (attempt <= opts.maxRetries) {
          var delay = opts.retryDelayMs * attempt;
          setTimer(executeAttempt, delay);
        } else if (cbs.onError) {
          cbs.onError(new Error(reason || 'Failed to load manifest from ' + manifestUrl));
        }
      }

      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          if (settled) {
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              var parsed = JSON.parse(xhr.responseText);
              settled = true;
              var result = injectManifestAssets(parsed, opts, opts.document);
              if (cbs.onSuccess) {
                cbs.onSuccess(parsed, result);
              }
            } catch (parseErr) {
              handleFailure('Invalid JSON in manifest: ' + parseErr.message);
            }
          } else {
            handleFailure('HTTP ' + xhr.status + ' loading ' + manifestUrl);
          }
        }
      };

      xhr.onerror = function () {
        handleFailure('Network error loading ' + manifestUrl);
      };

      xhr.ontimeout = function () {
        handleFailure('Timeout loading ' + manifestUrl);
      };

      xhr.open('GET', manifestUrl, true);
      if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
        try {
          xhr.timeout = opts.timeoutMs;
        } catch (e) {}
      }
      xhr.send();
    }

    executeAttempt();
  }

  /**
   * Sets up D-Pad navigation and Retry/Exit handlers on the boot screen fallback panel.
   */
  function setupBootScreenController(doc, onRetry, onExit) {
    var targetDoc = doc || (typeof document !== 'undefined' ? document : null);
    if (!targetDoc) {
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
    var buttons = [btnRetry, btnExit];

    function updateFocus(idx) {
      focusedIndex = idx;
      for (var i = 0; i < buttons.length; i++) {
        if (!buttons[i]) continue;
        if (i === focusedIndex) {
          buttons[i].className = 'tv-btn focused';
          if (buttons[i].focus) buttons[i].focus();
        } else {
          buttons[i].className = 'tv-btn';
        }
      }
    }

    if (btnRetry) {
      btnRetry.onclick = function () {
        if (onRetry) onRetry();
      };
    }

    if (btnExit) {
      btnExit.onclick = function () {
        if (onExit) onExit();
      };
    }

    targetDoc.addEventListener('keydown', function (e) {
      if (!fallbackPanel || fallbackPanel.className.indexOf('visible') === -1) {
        return;
      }
      var code = e.keyCode;
      if (code === 37) {
        updateFocus(0);
        e.preventDefault();
      } else if (code === 39) {
        updateFocus(1);
        e.preventDefault();
      } else if (code === 13) {
        if (focusedIndex === 0 && onRetry) {
          onRetry();
        } else if (focusedIndex === 1 && onExit) {
          onExit();
        }
        e.preventDefault();
      } else if (code === 10009 || code === 27) {
        if (onExit) onExit();
      }
    });

    return {
      setStatus: function (text) {
        if (bootStatus) bootStatus.textContent = text;
        if (bootSpinner) bootSpinner.style.display = 'block';
        if (fallbackPanel) fallbackPanel.className = 'fallback-panel';
      },
      showError: function (errText) {
        if (bootStatus) bootStatus.textContent = 'Connection Error';
        if (bootSpinner) bootSpinner.style.display = 'none';
        if (fallbackMessage && errText) fallbackMessage.textContent = errText;
        if (fallbackPanel) fallbackPanel.className = 'fallback-panel visible';
        updateFocus(0);
      },
      hideBootScreen: function () {
        if (bootScreen) bootScreen.className = 'boot-screen hidden';
      }
    };
  }

  /**
   * Boots the foreground wrapper: initializes Tizen IPC/keys and loads the remote manifest.
   */
  function boot(customOptions) {
    var globalConfig =
      typeof window !== 'undefined' && window.OPEN_WEBTV_CONFIG ? window.OPEN_WEBTV_CONFIG : {};
    var opts = mergeOptions(customOptions || globalConfig);

    if (
      !customOptions &&
      !globalConfig.manifestDomain &&
      typeof window !== 'undefined' &&
      window.location &&
      /^https?:$/i.test(window.location.protocol)
    ) {
      opts.manifestDomain = window.location.origin;
    }

    var ipcBridge = null;
    if (typeof AppIPCBridge !== 'undefined' && AppIPCBridge.createIPCBridge) {
      ipcBridge = AppIPCBridge.createIPCBridge({
        previewFeedUrl: resolveUrl(opts.manifestDomain, '/preview.json')
      });
      ipcBridge.registerRemoteKeys();
      ipcBridge.initPreviewService();
    }

    var ui = setupBootScreenController(
      opts.document,
      function handleRetry() {
        startLoad();
      },
      function handleExit() {
        if (ipcBridge) {
          ipcBridge.exitApplication();
        }
      }
    );

    function startLoad() {
      loadManifest(opts, {
        onStatus: function (msg) {
          if (ui) ui.setStatus(msg);
        },
        onSuccess: function () {
          if (ui) ui.hideBootScreen();
        },
        onError: function (err) {
          if (ui) ui.showError(err.message);
        }
      });
    }

    startLoad();
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    mergeOptions: mergeOptions,
    resolveUrl: resolveUrl,
    injectManifestAssets: injectManifestAssets,
    loadManifest: loadManifest,
    setupBootScreenController: setupBootScreenController,
    boot: boot
  };
});
