/**
 * Open WebTV - Hybrid Video Player Engine & Deep-Link Resolver (vendors.js)
 *
 * Provides a unified player API across:
 * 1. Samsung Tizen Hardware `webapis.avplay` (for direct MKV, HEVC/H.265, 4K HDR, AC3/EAC3, multi-audio)
 * 2. Standard HTML5 `<video>` (with WebVTT `<track>` subtitles, variable playback speed, and aspect ratio modes)
 *
 * Written in ES5-compatible UMD format so it runs on Tizen 2.4+ through 8.0+ TVs,
 * desktop browsers, and Node.js unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OpenWebTVPlayer = factory();
    root.__OPEN_WEBTV_VENDORS__ = {
      spatialNavigation: true,
      hlsSupport: true,
      avplayBridge: true
    };
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ASPECT_MODES = ['contain', 'cover', 'fill'];
  var PLAYBACK_RATES = [0.75, 1.0, 1.25, 1.5, 2.0];

  function formatTime(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var hrs = Math.floor(s / 3600);
    var mins = Math.floor((s % 3600) / 60);
    var secs = s % 60;
    var mm = mins < 10 ? '0' + mins : String(mins);
    var ss = secs < 10 ? '0' + secs : String(secs);
    if (hrs > 0) {
      return hrs + ':' + mm + ':' + ss;
    }
    return mm + ':' + ss;
  }

  /**
   * Parses an `action_data` deep-link string such as:
   * - "watch/file-1234abcd?t=142"
   * - "watch/open-big-buck-bunny"
   */
  function parseActionData(rawActionData) {
    if (!rawActionData || typeof rawActionData !== 'string') {
      return null;
    }
    var trimmed = rawActionData.trim();
    var qIndex = trimmed.indexOf('?');
    var pathPart = qIndex !== -1 ? trimmed.slice(0, qIndex) : trimmed;
    var queryPart = qIndex !== -1 ? trimmed.slice(qIndex + 1) : '';
    var resumeSec = 0;

    if (queryPart) {
      var pairs = queryPart.split('&');
      for (var i = 0; i < pairs.length; i++) {
        var kv = pairs[i].split('=');
        if (kv[0] === 't' && kv[1]) {
          resumeSec = Math.max(0, Number(kv[1]) || 0);
        }
      }
    }

    var segments = pathPart.split('/');
    var command = segments[0];
    var itemId = segments.slice(1).join('/');
    if (!itemId) {
      return null;
    }

    return {
      command: command,
      itemId: itemId,
      resumeSec: resumeSec
    };
  }

  /**
   * Extracts deep-link `action_data` from Samsung Tizen `appcontrol` PAYLOAD or URL query params.
   */
  function extractDeepLinkFromEnvironment(tizenObj, locationSearch) {
    // 1. Check Tizen RequestedAppControl PAYLOAD (Smart Hub Preview tile click)
    var tz = tizenObj || (typeof tizen !== 'undefined' ? tizen : null);
    if (tz && tz.application && typeof tz.application.getCurrentApplication === 'function') {
      try {
        var reqCtrl = tz.application.getCurrentApplication().getRequestedAppControl();
        if (reqCtrl && reqCtrl.appControl && Array.isArray(reqCtrl.appControl.data)) {
          var dataArr = reqCtrl.appControl.data;
          for (var i = 0; i < dataArr.length; i++) {
            var entry = dataArr[i];
            if (entry && entry.key === 'PAYLOAD' && entry.value && entry.value.length > 0) {
              var rawVal = entry.value[0];
              try {
                var parsed = JSON.parse(rawVal);
                if (parsed && parsed.values) {
                  return parseActionData(parsed.values);
                }
              } catch (e) {
                return parseActionData(rawVal);
              }
            }
          }
        }
      } catch (e) {
        // Ignore if not running inside Tizen application context
      }
    }

    // 2. Check URL query string (?action_data=play/...)
    var search =
      locationSearch !== undefined
        ? locationSearch
        : typeof window !== 'undefined' && window.location
          ? window.location.search
          : '';
    if (search && search.length > 1) {
      var clean = search.charAt(0) === '?' ? search.slice(1) : search;
      var parts = clean.split('&');
      for (var j = 0; j < parts.length; j++) {
        var pair = parts[j].split('=');
        if (pair[0] === 'action_data' && pair[1]) {
          return parseActionData(decodeURIComponent(pair[1]));
        }
      }
    }

    return null;
  }

  /**
   * Creates a unified Hybrid Video Player controller (`avplay` + `html5`).
   */
  function createHybridPlayer(options) {
    var opts = options || {};
    var webapisObj = opts.webapis || (typeof webapis !== 'undefined' ? webapis : null);
    var videoElement = opts.videoElement || null;
    var onStateChange = opts.onStateChange || function () {};
    var onTimeUpdate = opts.onTimeUpdate || function () {};
    var onSubtitleText = opts.onSubtitleText || function () {};
    var onError = opts.onError || function () {};

    var state = {
      backend: 'html5', // 'html5' or 'avplay'
      status: 'idle', // 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
      currentTime: 0,
      duration: 0,
      subtitlesEnabled: true,
      aspectIndex: 0,
      aspectMode: ASPECT_MODES[0],
      rateIndex: 1,
      playbackRate: PLAYBACK_RATES[1],
      audioTracks: [],
      activeAudioTrackIndex: 0,
      item: null
    };

    function notifyState() {
      onStateChange(state);
    }

    function isAvPlayAvailable() {
      return Boolean(webapisObj && webapisObj.avplay && typeof webapisObj.avplay.open === 'function');
    }

    function selectBackendForItem(item, forceBackend) {
      if (forceBackend === 'avplay' && isAvPlayAvailable()) {
        return 'avplay';
      }
      if (forceBackend === 'html5') {
        return 'html5';
      }
      if (item && item.prefersAvPlay && isAvPlayAvailable()) {
        return 'avplay';
      }
      return 'html5';
    }

    function stop() {
      if (state.backend === 'avplay' && isAvPlayAvailable()) {
        try {
          webapisObj.avplay.stop();
          webapisObj.avplay.close();
        } catch (e) {}
      }
      if (videoElement) {
        try {
          videoElement.pause();
          videoElement.removeAttribute('src');
          if (typeof videoElement.load === 'function') {
            videoElement.load();
          }
        } catch (e) {}
      }
      state.status = 'idle';
      notifyState();
    }

    function load(item, startOptions) {
      var sOpts = startOptions || {};
      stop();

      state.item = item;
      state.currentTime = Number(sOpts.startTimeSec) || 0;
      state.duration = 0;
      state.status = 'loading';
      state.backend = selectBackendForItem(item, sOpts.forceBackend);
      notifyState();

      if (state.backend === 'avplay') {
        try {
          var avplay = webapisObj.avplay;
          avplay.open(item.streamUrl);
          avplay.setDisplayRect(0, 0, 1920, 1080);
          avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO');

          avplay.setListener({
            onbufferingstart: function () {
              state.status = 'loading';
              notifyState();
            },
            onbufferingcomplete: function () {
              state.status = 'playing';
              notifyState();
            },
            oncurrentplaytime: function (ms) {
              state.currentTime = Math.floor((Number(ms) || 0) / 1000);
              var durMs = avplay.getDuration ? avplay.getDuration() : 0;
              state.duration = Math.floor((Number(durMs) || 0) / 1000);
              onTimeUpdate(state.currentTime, state.duration);
            },
            onsubtitlechange: function (_duration, text) {
              if (state.subtitlesEnabled) {
                onSubtitleText(text || '');
              }
            },
            onstreamcompleted: function () {
              state.status = 'ended';
              notifyState();
              avplay.stop();
            },
            onerror: function (errType) {
              state.status = 'error';
              notifyState();
              onError('AVPlay hardware error: ' + errType);
            }
          });

          avplay.prepareAsync(
            function () {
              var durMs = avplay.getDuration ? avplay.getDuration() : 0;
              state.duration = Math.floor((Number(durMs) || 0) / 1000);

              // Enumerate audio tracks if available
              if (typeof avplay.getTotalTrackInfo === 'function') {
                var tracks = avplay.getTotalTrackInfo() || [];
                var audioList = [];
                for (var i = 0; i < tracks.length; i++) {
                  if (tracks[i].type === 'AUDIO') {
                    audioList.push(tracks[i]);
                  }
                }
                state.audioTracks = audioList;
              }

              if (state.currentTime > 0 && typeof avplay.seekTo === 'function') {
                avplay.seekTo(state.currentTime * 1000);
              }
              avplay.play();
              state.status = 'playing';
              notifyState();
            },
            function (err) {
              state.status = 'error';
              notifyState();
              onError('AVPlay prepareAsync failed: ' + (err && err.message ? err.message : String(err)));
            }
          );
          return state.backend;
        } catch (err) {
          onError('AVPlay exception, falling back to HTML5 video: ' + err.message);
          state.backend = 'html5';
        }
      }

      // HTML5 <video> backend
      if (videoElement) {
        videoElement.src = item.streamUrl;
        videoElement.playbackRate = state.playbackRate;
        videoElement.style.objectFit = state.aspectMode;

        // Configure WebVTT <track>
        var existingTracks = videoElement.querySelectorAll
          ? videoElement.querySelectorAll('track')
          : [];
        for (var t = 0; t < existingTracks.length; t++) {
          if (existingTracks[t].parentNode) {
            existingTracks[t].parentNode.removeChild(existingTracks[t]);
          }
        }

        if (item.subtitleUrl && videoElement.ownerDocument) {
          var trackEl = videoElement.ownerDocument.createElement('track');
          trackEl.kind = 'subtitles';
          trackEl.label = 'English';
          trackEl.srclang = 'en';
          trackEl.src = item.subtitleUrl;
          trackEl.default = state.subtitlesEnabled;
          videoElement.appendChild(trackEl);
        }

        videoElement.onloadedmetadata = function () {
          state.duration = Math.floor(Number(videoElement.duration) || 0);
          if (state.currentTime > 0 && state.currentTime < state.duration) {
            videoElement.currentTime = state.currentTime;
          }
          notifyState();
        };

        videoElement.ontimeupdate = function () {
          state.currentTime = Math.floor(Number(videoElement.currentTime) || 0);
          state.duration = Math.floor(Number(videoElement.duration) || 0);
          onTimeUpdate(state.currentTime, state.duration);
        };

        videoElement.onplay = function () {
          state.status = 'playing';
          notifyState();
        };

        videoElement.onpause = function () {
          if (state.status !== 'idle' && state.status !== 'ended') {
            state.status = 'paused';
            notifyState();
          }
        };

        videoElement.onended = function () {
          state.status = 'ended';
          notifyState();
        };

        videoElement.onerror = function () {
          state.status = 'error';
          notifyState();
          onError('HTML5 video element failed to load stream: ' + item.streamUrl);
        };

        var playPromise = videoElement.play ? videoElement.play() : null;
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise
            .then(function () {
              state.status = 'playing';
              notifyState();
            })
            .catch(function () {
              state.status = 'paused';
              notifyState();
            });
        } else {
          state.status = 'playing';
          notifyState();
        }
      }

      return state.backend;
    }

    function togglePlayPause() {
      if (state.backend === 'avplay' && isAvPlayAvailable()) {
        try {
          if (state.status === 'playing') {
            webapisObj.avplay.pause();
            state.status = 'paused';
          } else {
            webapisObj.avplay.play();
            state.status = 'playing';
          }
          notifyState();
        } catch (e) {}
        return state.status;
      }

      if (videoElement) {
        if (videoElement.paused) {
          videoElement.play();
          state.status = 'playing';
        } else {
          videoElement.pause();
          state.status = 'paused';
        }
        notifyState();
      }
      return state.status;
    }

    function seekRelative(deltaSeconds) {
      var delta = Number(deltaSeconds) || 0;
      var target = Math.max(0, state.currentTime + delta);
      if (state.duration > 0) {
        target = Math.min(state.duration, target);
      }

      if (state.backend === 'avplay' && isAvPlayAvailable()) {
        try {
          if (delta > 0 && webapisObj.avplay.jumpForward) {
            webapisObj.avplay.jumpForward(delta * 1000);
          } else if (delta < 0 && webapisObj.avplay.jumpBackward) {
            webapisObj.avplay.jumpBackward(Math.abs(delta) * 1000);
          }
          state.currentTime = target;
          notifyState();
        } catch (e) {}
        return state.currentTime;
      }

      if (videoElement) {
        videoElement.currentTime = target;
        state.currentTime = target;
        notifyState();
      }
      return state.currentTime;
    }

    function toggleSubtitles() {
      state.subtitlesEnabled = !state.subtitlesEnabled;
      if (videoElement && videoElement.textTracks) {
        for (var i = 0; i < videoElement.textTracks.length; i++) {
          videoElement.textTracks[i].mode = state.subtitlesEnabled ? 'showing' : 'hidden';
        }
      }
      if (!state.subtitlesEnabled) {
        onSubtitleText('');
      }
      notifyState();
      return state.subtitlesEnabled;
    }

    function cycleAspectMode() {
      state.aspectIndex = (state.aspectIndex + 1) % ASPECT_MODES.length;
      state.aspectMode = ASPECT_MODES[state.aspectIndex];
      if (videoElement && videoElement.style) {
        videoElement.style.objectFit = state.aspectMode;
      }
      notifyState();
      return state.aspectMode;
    }

    function cyclePlaybackRate() {
      state.rateIndex = (state.rateIndex + 1) % PLAYBACK_RATES.length;
      state.playbackRate = PLAYBACK_RATES[state.rateIndex];
      if (videoElement) {
        videoElement.playbackRate = state.playbackRate;
      }
      notifyState();
      return state.playbackRate;
    }

    function cycleAudioTrack() {
      if (state.backend === 'avplay' && isAvPlayAvailable() && state.audioTracks.length > 1) {
        state.activeAudioTrackIndex = (state.activeAudioTrackIndex + 1) % state.audioTracks.length;
        var track = state.audioTracks[state.activeAudioTrackIndex];
        try {
          webapisObj.avplay.setSelectTrack('AUDIO', track.index);
        } catch (e) {}
        notifyState();
      }
      return state.activeAudioTrackIndex;
    }

    return {
      state: state,
      load: load,
      stop: stop,
      togglePlayPause: togglePlayPause,
      seekRelative: seekRelative,
      toggleSubtitles: toggleSubtitles,
      cycleAspectMode: cycleAspectMode,
      cyclePlaybackRate: cyclePlaybackRate,
      cycleAudioTrack: cycleAudioTrack,
      isAvPlayAvailable: isAvPlayAvailable
    };
  }

  return {
    ASPECT_MODES: ASPECT_MODES,
    PLAYBACK_RATES: PLAYBACK_RATES,
    formatTime: formatTime,
    parseActionData: parseActionData,
    extractDeepLinkFromEnvironment: extractDeepLinkFromEnvironment,
    createHybridPlayer: createHybridPlayer
  };
});
