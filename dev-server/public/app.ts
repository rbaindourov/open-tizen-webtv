/**
 * Open WebTV - Strictly Typed 10-Foot Smart TV Media Center & Hybrid Player UI (`app.ts` -> `/assets/app.js`)
 */

import type { CatalogItem, WatchProgressEntry } from '../types.ts';
import type {
  DeepLinkTarget,
  HybridPlayerInstance,
  HybridPlayerOptions,
  HybridPlayerState,
  VideoElementLike
} from './player.ts';

export type FilterCategory = 'all' | 'continue' | 'favorites' | 'smb' | 'm3u' | 'open';

export interface PlayerEngineGlobal {
  formatTime(seconds: number): string;
  extractDeepLinkFromEnvironment(): DeepLinkTarget | null;
  createHybridPlayer(options?: HybridPlayerOptions): HybridPlayerInstance;
}

export interface ApiResponsePayload {
  readonly ok?: boolean;
  readonly items?: CatalogItem[];
  readonly isFavorite?: boolean;
  readonly progress?: WatchProgressEntry | null;
}

/**
 * Escapes HTML special characters to prevent DOM injection from untrusted M3U or NFO strings.
 */
export function escapeHtml(raw: string | number | null | undefined): string {
  var str = String(raw !== undefined && raw !== null ? raw : '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * ES5-compatible shallow clone helper for CatalogItem updates (avoids ES6 Object.assign on Tizen 2.4).
 */
export function cloneCatalogItem(
  base: CatalogItem,
  overrides: Partial<CatalogItem>
): CatalogItem {
  var copy: Record<string, unknown> = {};
  var sourceRecord = base as unknown as Record<string, unknown>;
  var overrideRecord = overrides as unknown as Record<string, unknown>;
  var key: string;

  for (key in sourceRecord) {
    if (Object.prototype.hasOwnProperty.call(sourceRecord, key)) {
      copy[key] = sourceRecord[key];
    }
  }
  for (key in overrideRecord) {
    if (
      Object.prototype.hasOwnProperty.call(overrideRecord, key) &&
      overrideRecord[key] !== undefined
    ) {
      copy[key] = overrideRecord[key];
    }
  }
  return copy as unknown as CatalogItem;
}

/**
 * Resolves relative server routes (`/api/*`, `/log`, `/assets/*`) against the configured
 * media server origin so the UI works both over HTTP and inside a `file://` Tizen `.wgt` package.
 */
export function resolveServerUrl(pathOrUrl: string, explicitBaseDomain?: string): string {
  if (!pathOrUrl) {
    return '';
  }
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  var base = explicitBaseDomain || '';
  if (!base && typeof window !== 'undefined') {
    var winObj = window as unknown as {
      OPEN_WEBTV_CONFIG?: { manifestDomain?: string };
      ManifestLoader?: { DEFAULT_OPTIONS?: { manifestDomain?: string } };
      location?: { protocol?: string; origin?: string };
    };
    if (winObj.OPEN_WEBTV_CONFIG && winObj.OPEN_WEBTV_CONFIG.manifestDomain) {
      base = winObj.OPEN_WEBTV_CONFIG.manifestDomain;
    } else if (
      winObj.location &&
      winObj.location.protocol &&
      /^https?:$/i.test(winObj.location.protocol) &&
      winObj.location.origin
    ) {
      base = winObj.location.origin;
    } else if (
      winObj.ManifestLoader &&
      winObj.ManifestLoader.DEFAULT_OPTIONS &&
      winObj.ManifestLoader.DEFAULT_OPTIONS.manifestDomain
    ) {
      base = winObj.ManifestLoader.DEFAULT_OPTIONS.manifestDomain;
    }
  }

  if (!base) {
    return pathOrUrl;
  }
  var cleanBase = String(base).replace(/\/+$/, '');
  var cleanPath = String(pathOrUrl).charAt(0) === '/' ? pathOrUrl : '/' + pathOrUrl;
  return cleanBase + cleanPath;
}

export function initMediaCenterApp(): void {
  if (typeof document === 'undefined') {
    return;
  }

  var rootContainer = document.getElementById('app-root');
  if (!rootContainer) {
    return;
  }
  var container: HTMLElement = rootContainer;

  var win = window as unknown as { OpenWebTVPlayer?: PlayerEngineGlobal };
  var PlayerEngine: PlayerEngineGlobal | null = win.OpenWebTVPlayer || null;

  var allItems: CatalogItem[] = [];
  var filteredItems: CatalogItem[] = [];
  var selectedIndex = 0;
  var activeCategory: FilterCategory = 'all';
  var searchQuery = '';
  var playerInstance: HybridPlayerInstance | null = null;
  var isPlayerOpen = false;
  var lastProgressSentAt = 0;

  function sendTelemetryLog(message: string, data?: Record<string, unknown>): void {
    var xhr = new XMLHttpRequest();
    var logUrl = resolveServerUrl(
      '/log?source=webtv-ui&message=' +
        encodeURIComponent(message) +
        '&data=' +
        encodeURIComponent(JSON.stringify(data || {}))
    );
    xhr.open('GET', logUrl, true);
    xhr.send();
  }

  function postJson(
    url: string,
    payload: Record<string, unknown>,
    callback?: (status: number, resp: ApiResponsePayload | null) => void
  ): void {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', resolveServerUrl(url), true);
    xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
    xhr.onreadystatechange = function (): void {
      if (xhr.readyState === 4) {
        var parsed: ApiResponsePayload | null = null;
        try {
          parsed = JSON.parse(xhr.responseText) as ApiResponsePayload;
        } catch (_e: unknown) {}
        if (callback) callback(xhr.status, parsed);
      }
    };
    xhr.send(JSON.stringify(payload || {}));
  }

  function applyFilters(): void {
    filteredItems = [];
    var q: string = searchQuery.toLowerCase().trim();
    for (var i = 0; i < allItems.length; i++) {
      var item = allItems[i];
      if (!item) continue;
      if (
        activeCategory === 'continue' &&
        (!item.progress || item.progress.positionSec <= 5)
      ) {
        continue;
      }
      if (activeCategory === 'favorites' && !item.isFavorite) {
        continue;
      }
      if (activeCategory === 'smb' && item.category !== 'smb') {
        continue;
      }
      if (activeCategory === 'm3u' && item.category !== 'm3u') {
        continue;
      }
      if (activeCategory === 'open' && item.category !== 'open') {
        continue;
      }
      if (q) {
        var haystack: string = (
          item.title +
          ' ' +
          (item.subtitle || '') +
          ' ' +
          (item.resolution || '') +
          ' ' +
          (item.videoCodec || '')
        ).toLowerCase();
        if (haystack.indexOf(q) === -1) continue;
      }
      filteredItems.push(item);
    }
    if (selectedIndex >= filteredItems.length) {
      selectedIndex = 0;
    }
  }

  function buildChannelListHtml(): string {
    if (filteredItems.length === 0) {
      return '<div style="padding:18px;color:#94a3b8;font-size:14px;">No media items match this filter. Click "+ Source" to mount an SMB folder or stream.</div>';
    }
    var html = '';
    for (var i = 0; i < filteredItems.length; i++) {
      var ch = filteredItems[i];
      if (!ch) continue;
      var activeClass: string =
        i === selectedIndex ? 'webtv-channel-card active' : 'webtv-channel-card';
      var starHtml: string = ch.isFavorite ? '<span class="webtv-fav-star">★</span>' : '';
      var progressHtml = '';
      if (ch.progress && ch.progress.percent > 0) {
        progressHtml =
          '<div class="webtv-progress-bar"><div class="webtv-progress-fill" style="width:' +
          Math.min(100, Math.max(0, Number(ch.progress.percent) || 0)) +
          '%"></div></div>';
      }
      html +=
        '<div class="' +
        activeClass +
        '" data-index="' +
        i +
        '">' +
        '  <div class="webtv-channel-header">' +
        '    <div class="webtv-channel-name">' +
        escapeHtml(ch.title) +
        '</div>' +
        starHtml +
        '  </div>' +
        '  <div class="webtv-channel-meta">' +
        escapeHtml(ch.subtitle || ch.action_data) +
        '</div>' +
        progressHtml +
        '</div>';
    }
    return html;
  }

  function createFallbackItem(): CatalogItem {
    var bgUrl = resolveServerUrl('/assets/background.svg');
    return {
      id: 'none',
      title: 'No Media Found',
      subtitle: 'Mount an SMB folder or add a stream URL',
      description: 'Use the "+ Mount SMB / Stream" button to connect your media library.',
      category: 'open',
      sourceType: 'remote',
      resolution: 'HD',
      videoCodec: 'H.264',
      audioCodec: 'AAC',
      prefersAvPlay: false,
      streamUrl: '',
      image_ratio: '16by9',
      image_url: bgUrl,
      backdrop_url: bgUrl,
      action_data: 'none',
      is_playable: false
    };
  }

  function renderApp(): void {
    if (isPlayerOpen) {
      return;
    }
    applyFilters();

    var activeItem: CatalogItem =
      filteredItems[selectedIndex] || allItems[0] || createFallbackItem();

    var hasResume = Boolean(activeItem.progress && activeItem.progress.positionSec > 5);
    var resumeSec: number =
      activeItem.progress && activeItem.progress.positionSec
        ? activeItem.progress.positionSec
        : 0;
    var resumeLabel: string =
      hasResume && PlayerEngine
        ? 'Resume (' + PlayerEngine.formatTime(resumeSec) + ')'
        : '▶ Play Now';

    var categories: Array<{ id: FilterCategory; label: string }> = [
      { id: 'all', label: 'All (' + allItems.length + ')' },
      { id: 'continue', label: 'Continue' },
      { id: 'favorites', label: '★ Favorites' },
      { id: 'smb', label: 'SMB / Local' },
      { id: 'm3u', label: 'M3U' },
      { id: 'open', label: 'Open Movies' }
    ];

    var tabsHtml = '';
    for (var c = 0; c < categories.length; c++) {
      var cat = categories[c];
      if (!cat) continue;
      var cls: string =
        cat.id === activeCategory ? 'webtv-tab-btn active' : 'webtv-tab-btn';
      tabsHtml +=
        '<button type="button" class="' +
        cls +
        '" data-cat="' +
        escapeHtml(cat.id) +
        '">' +
        escapeHtml(cat.label) +
        '</button>';
    }

    var badgesHtml = '';
    if (activeItem.resolution) {
      badgesHtml +=
        '<span class="webtv-badge">' + escapeHtml(activeItem.resolution) + '</span>';
    }
    if (activeItem.videoCodec) {
      badgesHtml +=
        '<span class="webtv-badge">' + escapeHtml(activeItem.videoCodec) + '</span>';
    }
    if (activeItem.audioCodec) {
      badgesHtml +=
        '<span class="webtv-badge">' + escapeHtml(activeItem.audioCodec) + '</span>';
    }
    if (activeItem.hasSubtitles) {
      badgesHtml += '<span class="webtv-badge">CC / VTT</span>';
    }
    if (activeItem.prefersAvPlay) {
      badgesHtml += '<span class="webtv-badge avplay">AVPlay Direct Hardware</span>';
    } else {
      badgesHtml += '<span class="webtv-badge">HTTP 206 Byte-Range</span>';
    }

    var stageBackgroundUrl: string = resolveServerUrl(
      activeItem.backdrop_url || activeItem.image_url || '/assets/background.svg'
    );

    container.innerHTML =
      '<div class="webtv-shell">' +
      '  <aside class="webtv-sidebar">' +
      '    <div class="webtv-brand">' +
      '      <div class="webtv-brand-left">' +
      '        <div class="webtv-brand-badge">TV</div>' +
      '        <div>' +
      '          <div class="webtv-brand-title">Open WebTV</div>' +
      '          <div class="webtv-brand-sub">SMB • DLNA • M3U • Tizen</div>' +
      '        </div>' +
      '      </div>' +
      '      <button type="button" id="btn-open-source-modal" class="webtv-tab-btn" title="Add SMB Share or M3U Stream">+ Source</button>' +
      '    </div>' +
      '    <div class="webtv-filter-tabs" id="filter-tabs">' +
      tabsHtml +
      '    </div>' +
      '    <input type="text" id="catalog-search" class="webtv-search-input" placeholder="Search title, 4K, HEVC..." value="' +
      escapeHtml(searchQuery) +
      '" />' +
      '    <div class="webtv-channel-list" id="channel-list">' +
      buildChannelListHtml() +
      '    </div>' +
      '  </aside>' +
      '  <main class="webtv-main">' +
      '    <section class="webtv-stage" style="background-image: url(\'' +
      escapeHtml(stageBackgroundUrl) +
      '\')">' +
      '      <div class="webtv-stage-overlay">' +
      '        <div class="webtv-badges">' +
      badgesHtml +
      '        </div>' +
      '        <h2 class="webtv-stage-title">' +
      escapeHtml(activeItem.title) +
      (activeItem.year ? ' (' + escapeHtml(activeItem.year) + ')' : '') +
      '</h2>' +
      '        <p class="webtv-stage-desc">' +
      escapeHtml(activeItem.description || activeItem.subtitle || '') +
      '</p>' +
      '        <div class="webtv-action-row">' +
      '          <button type="button" id="btn-play-primary" class="webtv-btn primary">' +
      escapeHtml(resumeLabel) +
      '</button>' +
      (hasResume
        ? '<button type="button" id="btn-play-restart" class="webtv-btn">Restart from Beginning</button>'
        : '') +
      '          <button type="button" id="btn-toggle-fav" class="webtv-btn">' +
      (activeItem.isFavorite ? '★ Favorited' : '☆ Favorite') +
      '</button>' +
      '          <button type="button" id="btn-add-source-hero" class="webtv-btn">+ Mount SMB / Stream</button>' +
      '        </div>' +
      '      </div>' +
      '    </section>' +
      '    <section class="webtv-diagnostics">' +
      '      <div class="webtv-panel">' +
      '        <h3>Media &amp; Tizen Runtime Status</h3>' +
      '        <div class="webtv-log-list">' +
      '          <div>• Active Stream: <code>' +
      escapeHtml(activeItem.streamUrl || 'N/A') +
      '</code></div>' +
      '          <div>• Stage Backdrop Asset: <code>' +
      escapeHtml(stageBackgroundUrl) +
      '</code></div>' +
      '          <div>• Deep-Link Action: <code>' +
      escapeHtml(activeItem.action_data) +
      '</code></div>' +
      '          <div>• Decoder Mode: ' +
      (activeItem.prefersAvPlay
        ? 'Samsung Hardware AVPlay (with HTML5 fallback)'
        : 'HTML5 Video + HTTP 206 Byte-Range') +
      '</div>' +
      '        </div>' +
      '      </div>' +
      '      <div class="webtv-panel">' +
      '        <h3>Samsung TV Remote Shortcuts</h3>' +
      '        <div class="webtv-log-list">' +
      '          <div>• Up / Down Arrows: Browse Library</div>' +
      '          <div>• Enter (Key 13): Play / Resume Selected Movie</div>' +
      '          <div>• Left / Right (in Player): Seek -15s / +30s</div>' +
      '          <div>• Red Button / Key F: Toggle Favorite ★</div>' +
      '        </div>' +
      '      </div>' +
      '    </section>' +
      '  </main>' +
      '</div>' +
      '<div id="player-modal" class="webtv-player-modal">' +
      '  <video id="webtv-video" class="webtv-video-element" crossorigin="anonymous" playsinline></video>' +
      '  <div id="webtv-subtitle-box" class="webtv-subtitle-overlay"></div>' +
      '  <div class="webtv-osd-top">' +
      '    <div style="display:flex;justify-content:space-between;align-items:center;">' +
      '      <div>' +
      '        <div id="osd-title" style="font-size:24px;font-weight:800;"></div>' +
      '        <div id="osd-meta" style="font-size:14px;color:#94a3b8;"></div>' +
      '      </div>' +
      '      <button type="button" id="btn-close-player" class="webtv-btn">✕ Close (Back)</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="webtv-osd-bottom">' +
      '    <div id="osd-progress-track" class="webtv-osd-progress-track">' +
      '      <div id="osd-progress-fill" class="webtv-osd-progress-fill"></div>' +
      '    </div>' +
      '    <div class="webtv-osd-controls">' +
      '      <div class="webtv-osd-btn-group">' +
      '        <button type="button" id="btn-osd-playpause" class="webtv-btn primary">⏸ Pause</button>' +
      '        <button type="button" id="btn-osd-rw" class="webtv-btn">⏪ -15s</button>' +
      '        <button type="button" id="btn-osd-ff" class="webtv-btn">⏩ +30s</button>' +
      '        <button type="button" id="btn-osd-cc" class="webtv-btn">CC: ON</button>' +
      '        <button type="button" id="btn-osd-aspect" class="webtv-btn">Aspect: contain</button>' +
      '        <button type="button" id="btn-osd-rate" class="webtv-btn">Speed: 1x</button>' +
      '      </div>' +
      '      <div id="osd-time" style="font-family:monospace;font-size:16px;color:#e2e8f0;">00:00 / 00:00</div>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div id="source-modal" class="webtv-modal-backdrop">' +
      '  <div class="webtv-modal-card">' +
      '    <h3 style="font-size:20px;font-weight:800;">Connect SMB Share, M3U Playlist, or Stream URL</h3>' +
      '    <div class="webtv-form-group">' +
      '      <label>Mount Local / SMB Directory Path on Server (e.g. /mnt/smb/movies)</label>' +
      '      <input type="text" id="input-smb-path" class="webtv-search-input" placeholder="/mnt/smb/movies" />' +
      '    </div>' +
      '    <div class="webtv-form-group">' +
      '      <label>Or Add Direct Stream URL (.mp4, .mkv, .m3u8)</label>' +
      '      <input type="text" id="input-stream-title" class="webtv-search-input" placeholder="Movie or Channel Title" />' +
      '      <input type="text" id="input-stream-url" class="webtv-search-input" placeholder="http://192.168.1.50:8096/Videos/movie.mkv" />' +
      '    </div>' +
      '    <div class="webtv-form-group">' +
      '      <label>Or Paste #EXTM3U Playlist Content</label>' +
      '      <textarea id="input-m3u-content" class="webtv-search-input" rows="3" placeholder="#EXTM3U&#10;#EXTINF:-1,Channel Name&#10;http://192.168.1.50:8080/live.m3u8"></textarea>' +
      '    </div>' +
      '    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">' +
      '      <button type="button" id="btn-cancel-source" class="webtv-btn">Cancel</button>' +
      '      <button type="button" id="btn-save-source" class="webtv-btn primary">Connect Source</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    bindDomEvents(activeItem);
  }

  function bindDomEvents(activeItem: CatalogItem): void {
    var tabButtons = container.querySelectorAll('[data-cat]');
    for (var i = 0; i < tabButtons.length; i++) {
      var tabBtn = tabButtons[i] as HTMLElement | undefined;
      if (!tabBtn) continue;
      tabBtn.onclick = function (this: GlobalEventHandlers): void {
        var el = this as unknown as HTMLElement;
        var catAttr = el.getAttribute('data-cat') as FilterCategory | null;
        if (catAttr) {
          activeCategory = catAttr;
          selectedIndex = 0;
          renderApp();
        }
      };
    }

    var searchInput = document.getElementById('catalog-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.oninput = function (this: GlobalEventHandlers): void {
        var inputEl = this as unknown as HTMLInputElement;
        searchQuery = inputEl.value;
        selectedIndex = 0;
        applyFilters();
        var listEl = document.getElementById('channel-list');
        if (listEl) listEl.innerHTML = buildChannelListHtml();
        bindChannelCardClicks();
      };
    }

    bindChannelCardClicks();

    var btnPlayPrimary = document.getElementById('btn-play-primary');
    if (btnPlayPrimary && activeItem && activeItem.id !== 'none') {
      btnPlayPrimary.onclick = function (): void {
        var resumeSec: number =
          activeItem.progress && activeItem.progress.positionSec > 5
            ? activeItem.progress.positionSec
            : 0;
        openPlayerForItem(activeItem, resumeSec);
      };
    }

    var btnPlayRestart = document.getElementById('btn-play-restart');
    if (btnPlayRestart && activeItem && activeItem.id !== 'none') {
      btnPlayRestart.onclick = function (): void {
        openPlayerForItem(activeItem, 0);
      };
    }

    var btnToggleFav = document.getElementById('btn-toggle-fav');
    if (btnToggleFav && activeItem && activeItem.id !== 'none') {
      btnToggleFav.onclick = function (): void {
        toggleItemFavorite(activeItem);
      };
    }

    var btnOpenSource = document.getElementById('btn-open-source-modal');
    var btnAddSourceHero = document.getElementById('btn-add-source-hero');
    var sourceModal = document.getElementById('source-modal');
    if (btnOpenSource && sourceModal) {
      btnOpenSource.onclick = function (): void {
        if (sourceModal) sourceModal.className = 'webtv-modal-backdrop open';
      };
    }
    if (btnAddSourceHero && sourceModal) {
      btnAddSourceHero.onclick = function (): void {
        if (sourceModal) sourceModal.className = 'webtv-modal-backdrop open';
      };
    }

    var btnCancelSource = document.getElementById('btn-cancel-source');
    if (btnCancelSource && sourceModal) {
      btnCancelSource.onclick = function (): void {
        if (sourceModal) sourceModal.className = 'webtv-modal-backdrop';
      };
    }

    var btnSaveSource = document.getElementById('btn-save-source');
    if (btnSaveSource) {
      btnSaveSource.onclick = function (): void {
        var smbInput = document.getElementById('input-smb-path') as HTMLInputElement | null;
        var titleInput = document.getElementById(
          'input-stream-title'
        ) as HTMLInputElement | null;
        var urlInput = document.getElementById('input-stream-url') as HTMLInputElement | null;
        var m3uInput = document.getElementById(
          'input-m3u-content'
        ) as HTMLTextAreaElement | null;

        var smbPath: string = smbInput ? smbInput.value.trim() : '';
        var streamTitle: string = titleInput ? titleInput.value.trim() : '';
        var streamUrl: string = urlInput ? urlInput.value.trim() : '';
        var m3uContent: string = m3uInput ? m3uInput.value.trim() : '';

        if (smbPath) {
          postJson('/api/sources/smb', { path: smbPath }, function (status, resp): void {
            if (status === 200 && resp && resp.items) {
              allItems = resp.items;
              activeCategory = 'smb';
              renderApp();
            }
          });
        } else if (m3uContent) {
          postJson(
            '/api/sources/m3u',
            { content: m3uContent },
            function (status, resp): void {
              if (status === 200 && resp && resp.items) {
                allItems = resp.items;
                activeCategory = 'm3u';
                renderApp();
              }
            }
          );
        } else if (streamTitle && streamUrl) {
          postJson(
            '/api/sources/stream',
            { title: streamTitle, streamUrl: streamUrl },
            function (status, resp): void {
              if (status === 200 && resp && resp.items) {
                allItems = resp.items;
                renderApp();
              }
            }
          );
        }
      };
    }

    var btnClosePlayer = document.getElementById('btn-close-player');
    if (btnClosePlayer) {
      btnClosePlayer.onclick = closePlayer;
    }
    var btnPlayPause = document.getElementById('btn-osd-playpause');
    if (btnPlayPause) {
      btnPlayPause.onclick = function (): void {
        if (playerInstance) playerInstance.togglePlayPause();
      };
    }
    var btnRw = document.getElementById('btn-osd-rw');
    if (btnRw) {
      btnRw.onclick = function (): void {
        if (playerInstance) playerInstance.seekRelative(-15);
      };
    }
    var btnFf = document.getElementById('btn-osd-ff');
    if (btnFf) {
      btnFf.onclick = function (): void {
        if (playerInstance) playerInstance.seekRelative(30);
      };
    }
    var btnCc = document.getElementById('btn-osd-cc');
    if (btnCc) {
      btnCc.onclick = function (): void {
        if (playerInstance && btnCc) {
          var on: boolean = playerInstance.toggleSubtitles();
          btnCc.textContent = 'CC: ' + (on ? 'ON' : 'OFF');
        }
      };
    }
    var btnAspect = document.getElementById('btn-osd-aspect');
    if (btnAspect) {
      btnAspect.onclick = function (): void {
        if (playerInstance && btnAspect) {
          var mode: string = playerInstance.cycleAspectMode();
          btnAspect.textContent = 'Aspect: ' + mode;
        }
      };
    }
    var btnRate = document.getElementById('btn-osd-rate');
    if (btnRate) {
      btnRate.onclick = function (): void {
        if (playerInstance && btnRate) {
          var rate: number = playerInstance.cyclePlaybackRate();
          btnRate.textContent = 'Speed: ' + rate + 'x';
        }
      };
    }
  }

  function bindChannelCardClicks(): void {
    var cards = container.querySelectorAll('.webtv-channel-card');
    for (var j = 0; j < cards.length; j++) {
      var card = cards[j] as HTMLElement | undefined;
      if (!card) continue;
      card.onclick = function (this: GlobalEventHandlers): void {
        var el = this as unknown as HTMLElement;
        var idx = Number(el.getAttribute('data-index'));
        selectChannel(idx);
      };
      card.ondblclick = function (this: GlobalEventHandlers): void {
        var el = this as unknown as HTMLElement;
        var idx = Number(el.getAttribute('data-index'));
        selectChannel(idx);
        var item = filteredItems[selectedIndex];
        if (item) {
          openPlayerForItem(item, item.progress ? item.progress.positionSec : 0);
        }
      };
    }
  }

  function toggleItemFavorite(item: CatalogItem): void {
    postJson('/api/favorites', { itemId: item.id }, function (status, resp): void {
      if (status === 200 && resp !== null) {
        for (var i = 0; i < allItems.length; i++) {
          var current = allItems[i];
          if (current && current.id === item.id) {
            allItems[i] = cloneCatalogItem(current, {
              isFavorite: Boolean(resp.isFavorite)
            });
          }
        }
        renderApp();
      }
    });
  }

  function openPlayerForItem(item: CatalogItem, startTimeSec: number): void {
    if (!PlayerEngine) return;
    var modal = document.getElementById('player-modal');
    var videoEl = document.getElementById('webtv-video') as unknown as VideoElementLike | null;
    var osdTitle = document.getElementById('osd-title');
    var osdMeta = document.getElementById('osd-meta');
    var osdTime = document.getElementById('osd-time');
    var osdFill = document.getElementById('osd-progress-fill');
    var osdPlayPause = document.getElementById('btn-osd-playpause');
    var subtitleBox = document.getElementById('webtv-subtitle-box');

    if (!modal || !videoEl) return;
    modal.className = 'webtv-player-modal open';
    isPlayerOpen = true;

    if (osdTitle) osdTitle.textContent = item.title;
    if (osdMeta) osdMeta.textContent = item.subtitle || item.streamUrl;

    var engine: PlayerEngineGlobal = PlayerEngine;

    playerInstance = engine.createHybridPlayer({
      videoElement: videoEl,
      onStateChange: function (st: HybridPlayerState): void {
        if (osdPlayPause) {
          osdPlayPause.textContent = st.status === 'playing' ? '⏸ Pause' : '▶ Play';
        }
      },
      onTimeUpdate: function (curSec: number, durSec: number): void {
        if (osdTime) {
          osdTime.textContent =
            engine.formatTime(curSec) + ' / ' + engine.formatTime(durSec);
        }
        if (osdFill && durSec > 0) {
          osdFill.style.width = Math.min(100, Math.round((curSec / durSec) * 100)) + '%';
        }
        var now: number = Date.now();
        if (now - lastProgressSentAt > 4000 && curSec > 0) {
          lastProgressSentAt = now;
          saveWatchProgress(item.id, curSec, durSec);
        }
      },
      onSubtitleText: function (text: string): void {
        if (subtitleBox) subtitleBox.textContent = text;
      },
      onError: function (errMsg: string): void {
        sendTelemetryLog('Player Error', { item: item.id, error: errMsg });
      }
    });

    playerInstance.load(item, { startTimeSec: startTimeSec || 0 });
    sendTelemetryLog('Playback started', {
      id: item.id,
      title: item.title,
      startTimeSec: startTimeSec || 0,
      backend: playerInstance.state.backend
    });
  }

  function saveWatchProgress(
    itemId: string,
    positionSec: number,
    durationSec: number
  ): void {
    postJson(
      '/api/progress',
      { itemId: itemId, positionSec: positionSec, durationSec: durationSec },
      function (status, resp): void {
        if (status === 200 && resp) {
          for (var i = 0; i < allItems.length; i++) {
            var existing = allItems[i];
            if (existing && existing.id === itemId) {
              allItems[i] = cloneCatalogItem(existing, {
                progress:
                  resp.progress && !resp.progress.completed ? resp.progress : null
              });
            }
          }
        }
      }
    );
  }

  function closePlayer(): void {
    if (!isPlayerOpen) return;
    if (playerInstance && playerInstance.state.item) {
      saveWatchProgress(
        playerInstance.state.item.id,
        playerInstance.state.currentTime,
        playerInstance.state.duration
      );
      playerInstance.stop();
    }
    isPlayerOpen = false;
    var modal = document.getElementById('player-modal');
    if (modal) modal.className = 'webtv-player-modal';
    renderApp();
  }

  function selectChannel(index: number): void {
    if (!filteredItems.length) return;
    var targetIndex = index;
    if (targetIndex < 0) targetIndex = filteredItems.length - 1;
    if (targetIndex >= filteredItems.length) targetIndex = 0;
    selectedIndex = targetIndex;
    renderApp();
    var selectedItem = filteredItems[selectedIndex];
    if (selectedItem) {
      sendTelemetryLog('Media item focused', {
        id: selectedItem.id,
        title: selectedItem.title
      });
    }
  }

  document.addEventListener('keydown', function (e: KeyboardEvent): void {
    var activeTag: string = document.activeElement ? document.activeElement.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
      if (e.keyCode === 27 || e.keyCode === 10009) {
        (document.activeElement as HTMLElement).blur();
      }
      return;
    }

    if (isPlayerOpen && playerInstance) {
      if (
        e.keyCode === 13 ||
        e.keyCode === 415 ||
        e.keyCode === 19 ||
        e.keyCode === 10252
      ) {
        playerInstance.togglePlayPause();
        e.preventDefault();
      } else if (e.keyCode === 37 || e.keyCode === 412) {
        playerInstance.seekRelative(-15);
        e.preventDefault();
      } else if (e.keyCode === 39 || e.keyCode === 417) {
        playerInstance.seekRelative(30);
        e.preventDefault();
      } else if (e.keyCode === 10009 || e.keyCode === 27 || e.keyCode === 413) {
        closePlayer();
        e.preventDefault();
      }
      return;
    }

    if (!filteredItems.length) return;
    if (e.keyCode === 38) {
      selectChannel(selectedIndex - 1);
      e.preventDefault();
    } else if (e.keyCode === 40) {
      selectChannel(selectedIndex + 1);
      e.preventDefault();
    } else if (e.keyCode === 13) {
      var item = filteredItems[selectedIndex];
      if (item) {
        openPlayerForItem(item, item.progress ? item.progress.positionSec : 0);
        e.preventDefault();
      }
    } else if (e.keyCode === 403 || e.keyCode === 70) {
      var favItem = filteredItems[selectedIndex];
      if (favItem) {
        toggleItemFavorite(favItem);
        e.preventDefault();
      }
    }
  });

  function checkAndTriggerDeepLink(): void {
    if (!PlayerEngine) return;
    var deepLink = PlayerEngine.extractDeepLinkFromEnvironment();
    if (!deepLink || !deepLink.itemId) return;
    for (var i = 0; i < allItems.length; i++) {
      var candidate = allItems[i];
      if (!candidate) continue;
      if (
        candidate.id === deepLink.itemId ||
        candidate.action_data === deepLink.command + '/' + deepLink.itemId
      ) {
        selectedIndex = i;
        renderApp();
        openPlayerForItem(candidate, deepLink.resumeSec || 0);
        return;
      }
    }
  }

  window.addEventListener('appcontrol', checkAndTriggerDeepLink);

  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function (): void {
    if (xhr.readyState === 4 && xhr.status === 200) {
      try {
        var data = JSON.parse(xhr.responseText) as { items?: CatalogItem[] };
        if (data && Array.isArray(data.items)) {
          allItems = data.items;
        }
      } catch (_e: unknown) {}
      renderApp();
      checkAndTriggerDeepLink();
      sendTelemetryLog('Open WebTV Media Center initialized', {
        totalItems: allItems.length
      });
    }
  };
  xhr.open('GET', resolveServerUrl('/api/catalog'), true);
  xhr.send();
}

initMediaCenterApp();
