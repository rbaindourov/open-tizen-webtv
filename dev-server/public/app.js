/* Open WebTV - 10-Foot Smart TV Media Center & Hybrid Player Application (app.js) */
(function () {
  'use strict';

  var container = document.getElementById('app-root');
  if (!container) return;

  var PlayerEngine = typeof OpenWebTVPlayer !== 'undefined' ? OpenWebTVPlayer : null;

  var allItems = [];
  var filteredItems = [];
  var selectedIndex = 0;
  var activeCategory = 'all'; // 'all' | 'continue' | 'favorites' | 'smb' | 'm3u' | 'open'
  var searchQuery = '';
  var playerInstance = null;
  var isPlayerOpen = false;
  var lastProgressSentAt = 0;

  function sendTelemetryLog(message, data) {
    var xhr = new XMLHttpRequest();
    xhr.open(
      'GET',
      '/log?source=webtv-ui&message=' +
        encodeURIComponent(message) +
        '&data=' +
        encodeURIComponent(JSON.stringify(data || {})),
      true
    );
    xhr.send();
  }

  function postJson(url, payload, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        var parsed = null;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch (e) {}
        if (callback) callback(xhr.status, parsed);
      }
    };
    xhr.send(JSON.stringify(payload || {}));
  }

  function applyFilters() {
    filteredItems = [];
    var q = searchQuery.toLowerCase().trim();
    for (var i = 0; i < allItems.length; i++) {
      var item = allItems[i];
      if (activeCategory === 'continue' && (!item.progress || item.progress.positionSec <= 5)) {
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
        var haystack = (
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

  function buildChannelListHtml() {
    if (filteredItems.length === 0) {
      return '<div style="padding:18px;color:#94a3b8;font-size:14px;">No media items match this filter. Click "+ Add SMB / Stream" to mount a folder or stream.</div>';
    }
    var html = '';
    for (var i = 0; i < filteredItems.length; i++) {
      var ch = filteredItems[i];
      var activeClass = i === selectedIndex ? 'webtv-channel-card active' : 'webtv-channel-card';
      var starHtml = ch.isFavorite ? '<span class="webtv-fav-star">★</span>' : '';
      var progressHtml = '';
      if (ch.progress && ch.progress.percent > 0) {
        progressHtml =
          '<div class="webtv-progress-bar"><div class="webtv-progress-fill" style="width:' +
          ch.progress.percent +
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
        ch.title +
        '</div>' +
        starHtml +
        '  </div>' +
        '  <div class="webtv-channel-meta">' +
        (ch.subtitle || ch.action_data) +
        '</div>' +
        progressHtml +
        '</div>';
    }
    return html;
  }

  function renderApp() {
    applyFilters();

    var activeItem = filteredItems[selectedIndex] ||
      allItems[0] || {
        id: 'none',
        title: 'No Media Found',
        subtitle: 'Mount an SMB folder or add a stream URL',
        description: 'Use the "+ Add SMB / Stream" button to connect your media library.',
        action_data: 'none',
        image_url: ''
      };

    var hasResume = activeItem.progress && activeItem.progress.positionSec > 5;
    var resumeLabel =
      hasResume && PlayerEngine
        ? 'Resume (' + PlayerEngine.formatTime(activeItem.progress.positionSec) + ')'
        : '▶ Play Now';

    var categories = [
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
      var cls = cat.id === activeCategory ? 'webtv-tab-btn active' : 'webtv-tab-btn';
      tabsHtml +=
        '<button type="button" class="' +
        cls +
        '" data-cat="' +
        cat.id +
        '">' +
        cat.label +
        '</button>';
    }

    var badgesHtml = '';
    if (activeItem.resolution) {
      badgesHtml += '<span class="webtv-badge">' + activeItem.resolution + '</span>';
    }
    if (activeItem.videoCodec) {
      badgesHtml += '<span class="webtv-badge">' + activeItem.videoCodec + '</span>';
    }
    if (activeItem.audioCodec) {
      badgesHtml += '<span class="webtv-badge">' + activeItem.audioCodec + '</span>';
    }
    if (activeItem.hasSubtitles) {
      badgesHtml += '<span class="webtv-badge">CC / VTT</span>';
    }
    if (activeItem.prefersAvPlay) {
      badgesHtml += '<span class="webtv-badge avplay">AVPlay Direct Hardware</span>';
    } else {
      badgesHtml += '<span class="webtv-badge">HTTP 206 Byte-Range</span>';
    }

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
      searchQuery.replace(/"/g, '&quot;') +
      '" />' +
      '    <div class="webtv-channel-list" id="channel-list">' +
      buildChannelListHtml() +
      '    </div>' +
      '  </aside>' +
      '  <main class="webtv-main">' +
      '    <section class="webtv-stage" style="background-image: url(\'' +
      (activeItem.image_url || '') +
      '\')">' +
      '      <div class="webtv-stage-overlay">' +
      '        <div class="webtv-badges">' +
      badgesHtml +
      '        </div>' +
      '        <h2 class="webtv-stage-title">' +
      activeItem.title +
      (activeItem.year ? ' (' + activeItem.year + ')' : '') +
      '</h2>' +
      '        <p class="webtv-stage-desc">' +
      (activeItem.description || activeItem.subtitle || '') +
      '</p>' +
      '        <div class="webtv-action-row">' +
      '          <button type="button" id="btn-play-primary" class="webtv-btn primary">' +
      resumeLabel +
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
      (activeItem.streamUrl || 'N/A') +
      '</code></div>' +
      '          <div>• Deep-Link Action: <code>' +
      activeItem.action_data +
      '</code></div>' +
      '          <div>• Decoder Mode: ' +
      (activeItem.prefersAvPlay
        ? 'Samsung Hardware AVPlay (with HTML5 fallback)'
        : 'HTML5 Video + HTTP 206 Byte-Range') +
      '</div>' +
      '          <div>• Smart Hub Preview: Dynamic Continue Watching + SMB Feed</div>' +
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
      /* Full-screen Video Player Modal */
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
      /* Add SMB Share / Stream Modal */
      '<div id="source-modal" class="webtv-modal-backdrop">' +
      '  <div class="webtv-modal-card">' +
      '    <h3 style="font-size:20px;font-weight:800;">Connect SMB Share, Local Folder, or Stream URL</h3>' +
      '    <div class="webtv-form-group">' +
      '      <label>Mount Local / SMB Directory Path on Server (e.g. /mnt/smb/movies)</label>' +
      '      <input type="text" id="input-smb-path" class="webtv-search-input" placeholder="/mnt/smb/movies" />' +
      '    </div>' +
      '    <div class="webtv-form-group">' +
      '      <label>Or Add Direct Stream URL (.mp4, .mkv, .m3u8)</label>' +
      '      <input type="text" id="input-stream-title" class="webtv-search-input" placeholder="Movie or Channel Title" />' +
      '      <input type="text" id="input-stream-url" class="webtv-search-input" placeholder="http://192.168.1.50:8096/Videos/movie.mkv" />' +
      '    </div>' +
      '    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:8px;">' +
      '      <button type="button" id="btn-cancel-source" class="webtv-btn">Cancel</button>' +
      '      <button type="button" id="btn-save-source" class="webtv-btn primary">Connect Source</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    bindDomEvents(activeItem);
  }

  function bindDomEvents(activeItem) {
    // Category tab clicks
    var tabButtons = container.querySelectorAll('[data-cat]');
    for (var i = 0; i < tabButtons.length; i++) {
      tabButtons[i].onclick = function () {
        activeCategory = this.getAttribute('data-cat');
        selectedIndex = 0;
        renderApp();
      };
    }

    // Search input
    var searchInput = document.getElementById('catalog-search');
    if (searchInput) {
      searchInput.oninput = function () {
        searchQuery = this.value;
        selectedIndex = 0;
        applyFilters();
        var listEl = document.getElementById('channel-list');
        if (listEl) listEl.innerHTML = buildChannelListHtml();
        bindChannelCardClicks();
      };
    }

    bindChannelCardClicks();

    // Primary Play / Resume button
    var btnPlayPrimary = document.getElementById('btn-play-primary');
    if (btnPlayPrimary && activeItem && activeItem.id !== 'none') {
      btnPlayPrimary.onclick = function () {
        var resumeSec =
          activeItem.progress && activeItem.progress.positionSec > 5
            ? activeItem.progress.positionSec
            : 0;
        openPlayerForItem(activeItem, resumeSec);
      };
    }

    // Restart button
    var btnPlayRestart = document.getElementById('btn-play-restart');
    if (btnPlayRestart && activeItem && activeItem.id !== 'none') {
      btnPlayRestart.onclick = function () {
        openPlayerForItem(activeItem, 0);
      };
    }

    // Favorite toggle button
    var btnToggleFav = document.getElementById('btn-toggle-fav');
    if (btnToggleFav && activeItem && activeItem.id !== 'none') {
      btnToggleFav.onclick = function () {
        toggleItemFavorite(activeItem);
      };
    }

    // Open Add Source Modal
    var btnOpenSource = document.getElementById('btn-open-source-modal');
    var btnAddSourceHero = document.getElementById('btn-add-source-hero');
    var sourceModal = document.getElementById('source-modal');
    if (btnOpenSource && sourceModal) {
      btnOpenSource.onclick = function () {
        sourceModal.className = 'webtv-modal-backdrop open';
      };
    }
    if (btnAddSourceHero && sourceModal) {
      btnAddSourceHero.onclick = function () {
        sourceModal.className = 'webtv-modal-backdrop open';
      };
    }

    var btnCancelSource = document.getElementById('btn-cancel-source');
    if (btnCancelSource && sourceModal) {
      btnCancelSource.onclick = function () {
        sourceModal.className = 'webtv-modal-backdrop';
      };
    }

    var btnSaveSource = document.getElementById('btn-save-source');
    if (btnSaveSource) {
      btnSaveSource.onclick = function () {
        var smbPath = document.getElementById('input-smb-path').value.trim();
        var streamTitle = document.getElementById('input-stream-title').value.trim();
        var streamUrl = document.getElementById('input-stream-url').value.trim();

        if (smbPath) {
          postJson('/api/sources/smb', { path: smbPath }, function (status, resp) {
            if (status === 200 && resp && resp.items) {
              allItems = resp.items;
              activeCategory = 'smb';
              renderApp();
            }
          });
        } else if (streamTitle && streamUrl) {
          postJson(
            '/api/sources/stream',
            { title: streamTitle, streamUrl: streamUrl },
            function (status, resp) {
              if (status === 200 && resp && resp.items) {
                allItems = resp.items;
                renderApp();
              }
            }
          );
        }
      };
    }

    // Player OSD button events
    var btnClosePlayer = document.getElementById('btn-close-player');
    if (btnClosePlayer) {
      btnClosePlayer.onclick = closePlayer;
    }
    var btnPlayPause = document.getElementById('btn-osd-playpause');
    if (btnPlayPause) {
      btnPlayPause.onclick = function () {
        if (playerInstance) playerInstance.togglePlayPause();
      };
    }
    var btnRw = document.getElementById('btn-osd-rw');
    if (btnRw) {
      btnRw.onclick = function () {
        if (playerInstance) playerInstance.seekRelative(-15);
      };
    }
    var btnFf = document.getElementById('btn-osd-ff');
    if (btnFf) {
      btnFf.onclick = function () {
        if (playerInstance) playerInstance.seekRelative(30);
      };
    }
    var btnCc = document.getElementById('btn-osd-cc');
    if (btnCc) {
      btnCc.onclick = function () {
        if (playerInstance) {
          var on = playerInstance.toggleSubtitles();
          btnCc.textContent = 'CC: ' + (on ? 'ON' : 'OFF');
        }
      };
    }
    var btnAspect = document.getElementById('btn-osd-aspect');
    if (btnAspect) {
      btnAspect.onclick = function () {
        if (playerInstance) {
          var mode = playerInstance.cycleAspectMode();
          btnAspect.textContent = 'Aspect: ' + mode;
        }
      };
    }
    var btnRate = document.getElementById('btn-osd-rate');
    if (btnRate) {
      btnRate.onclick = function () {
        if (playerInstance) {
          var rate = playerInstance.cyclePlaybackRate();
          btnRate.textContent = 'Speed: ' + rate + 'x';
        }
      };
    }
  }

  function bindChannelCardClicks() {
    var cards = container.querySelectorAll('.webtv-channel-card');
    for (var j = 0; j < cards.length; j++) {
      cards[j].onclick = function () {
        var idx = Number(this.getAttribute('data-index'));
        selectChannel(idx);
      };
      cards[j].ondblclick = function () {
        var idx = Number(this.getAttribute('data-index'));
        selectChannel(idx);
        var item = filteredItems[selectedIndex];
        if (item) openPlayerForItem(item, item.progress ? item.progress.positionSec : 0);
      };
    }
  }

  function toggleItemFavorite(item) {
    postJson('/api/favorites', { itemId: item.id }, function (status, resp) {
      if (status === 200 && resp) {
        item.isFavorite = resp.isFavorite;
        renderApp();
      }
    });
  }

  function openPlayerForItem(item, startTimeSec) {
    if (!PlayerEngine) return;
    var modal = document.getElementById('player-modal');
    var videoEl = document.getElementById('webtv-video');
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

    playerInstance = PlayerEngine.createHybridPlayer({
      videoElement: videoEl,
      onStateChange: function (st) {
        if (osdPlayPause) {
          osdPlayPause.textContent = st.status === 'playing' ? '⏸ Pause' : '▶ Play';
        }
      },
      onTimeUpdate: function (curSec, durSec) {
        if (osdTime) {
          osdTime.textContent =
            PlayerEngine.formatTime(curSec) + ' / ' + PlayerEngine.formatTime(durSec);
        }
        if (osdFill && durSec > 0) {
          osdFill.style.width = Math.min(100, Math.round((curSec / durSec) * 100)) + '%';
        }
        var now = Date.now();
        if (now - lastProgressSentAt > 4000 && curSec > 0) {
          lastProgressSentAt = now;
          saveWatchProgress(item.id, curSec, durSec);
        }
      },
      onSubtitleText: function (text) {
        if (subtitleBox) subtitleBox.textContent = text;
      },
      onError: function (errMsg) {
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

  function saveWatchProgress(itemId, positionSec, durationSec) {
    postJson(
      '/api/progress',
      { itemId: itemId, positionSec: positionSec, durationSec: durationSec },
      function (status, resp) {
        if (status === 200 && resp) {
          for (var i = 0; i < allItems.length; i++) {
            if (allItems[i].id === itemId) {
              allItems[i].progress = resp.progress && !resp.progress.completed ? resp.progress : null;
            }
          }
        }
      }
    );
  }

  function closePlayer() {
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

  function selectChannel(index) {
    if (!filteredItems.length) return;
    if (index < 0) index = filteredItems.length - 1;
    if (index >= filteredItems.length) index = 0;
    selectedIndex = index;
    renderApp();
    sendTelemetryLog('Media item focused', {
      id: filteredItems[selectedIndex].id,
      title: filteredItems[selectedIndex].title
    });
  }

  // Global TV Remote & Keyboard Controls
  document.addEventListener('keydown', function (e) {
    var activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
      if (e.keyCode === 27 || e.keyCode === 10009) {
        document.activeElement.blur();
      }
      return;
    }

    if (isPlayerOpen && playerInstance) {
      if (e.keyCode === 13 || e.keyCode === 415 || e.keyCode === 19 || e.keyCode === 10252) {
        // Enter or MediaPlayPause
        playerInstance.togglePlayPause();
        e.preventDefault();
      } else if (e.keyCode === 37 || e.keyCode === 412) {
        // Left or MediaRewind
        playerInstance.seekRelative(-15);
        e.preventDefault();
      } else if (e.keyCode === 39 || e.keyCode === 417) {
        // Right or MediaFastForward
        playerInstance.seekRelative(30);
        e.preventDefault();
      } else if (e.keyCode === 10009 || e.keyCode === 27 || e.keyCode === 413) {
        // Return / Escape / Stop
        closePlayer();
        e.preventDefault();
      }
      return;
    }

    if (!filteredItems.length) return;
    if (e.keyCode === 38) {
      // Up arrow
      selectChannel(selectedIndex - 1);
      e.preventDefault();
    } else if (e.keyCode === 40) {
      // Down arrow
      selectChannel(selectedIndex + 1);
      e.preventDefault();
    } else if (e.keyCode === 13) {
      // Enter -> Play active item
      var item = filteredItems[selectedIndex];
      if (item) {
        openPlayerForItem(item, item.progress ? item.progress.positionSec : 0);
        e.preventDefault();
      }
    } else if (e.keyCode === 403 || e.keyCode === 70) {
      // Red Color Button (403) or 'F' key -> Toggle Favorite
      var favItem = filteredItems[selectedIndex];
      if (favItem) {
        toggleItemFavorite(favItem);
        e.preventDefault();
      }
    }
  });

  function checkAndTriggerDeepLink() {
    if (!PlayerEngine) return;
    var deepLink = PlayerEngine.extractDeepLinkFromEnvironment();
    if (!deepLink || !deepLink.itemId) return;
    for (var i = 0; i < allItems.length; i++) {
      if (
        allItems[i].id === deepLink.itemId ||
        allItems[i].action_data === deepLink.command + '/' + deepLink.itemId
      ) {
        selectedIndex = i;
        renderApp();
        openPlayerForItem(allItems[i], deepLink.resumeSec || 0);
        return;
      }
    }
  }

  window.addEventListener('appcontrol', checkAndTriggerDeepLink);

  // Load full catalog from /api/catalog
  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4 && xhr.status === 200) {
      try {
        var data = JSON.parse(xhr.responseText);
        if (data && Array.isArray(data.items)) {
          allItems = data.items;
        }
      } catch (e) {}
      renderApp();
      checkAndTriggerDeepLink();
      sendTelemetryLog('Open WebTV Media Center initialized', { totalItems: allItems.length });
    }
  };
  xhr.open('GET', '/api/catalog', true);
  xhr.send();
})();
