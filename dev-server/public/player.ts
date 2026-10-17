/**
 * Open WebTV - Strictly Typed Hybrid Video Player Engine & Deep-Link Resolver (`player.ts` -> `/assets/player.js`)
 *
 * Provides a unified player API across:
 * 1. Samsung Tizen Hardware `webapis.avplay` (for direct MKV, HEVC/H.265, 4K HDR, AC3/EAC3, multi-audio)
 * 2. Standard HTML5 `<video>` (with WebVTT `<track>` subtitles, variable playback speed, and aspect ratio modes)
 */

import type {
  AVPlayTrackInfo,
  TizenError,
  TizenNamespace,
  WebApisNamespace
} from '../../src/types/tizen.ts';

export type AspectMode = 'contain' | 'cover' | 'fill';
export type PlayerBackend = 'html5' | 'avplay';
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface DeepLinkTarget {
  readonly command: string;
  readonly itemId: string;
  readonly resumeSec: number;
}

export interface PlayableMediaItem {
  readonly id: string;
  readonly title: string;
  readonly streamUrl: string;
  readonly subtitleUrl?: string | null;
  readonly prefersAvPlay?: boolean;
}

export interface HybridPlayerState {
  backend: PlayerBackend;
  status: PlayerStatus;
  currentTime: number;
  duration: number;
  subtitlesEnabled: boolean;
  aspectIndex: number;
  aspectMode: AspectMode;
  rateIndex: number;
  playbackRate: number;
  audioTracks: AVPlayTrackInfo[];
  activeAudioTrackIndex: number;
  item: PlayableMediaItem | null;
}

export interface VideoTrackElementLike {
  kind: string;
  label: string;
  srclang: string;
  src: string;
  default: boolean;
  readonly parentNode?: { removeChild(child: VideoTrackElementLike): void } | null;
}

export interface VideoTextTrackLike {
  mode: 'disabled' | 'hidden' | 'showing';
}

export interface VideoElementLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  playbackRate: number;
  readonly paused: boolean;
  readonly style: { objectFit?: string };
  readonly textTracks?: ArrayLike<VideoTextTrackLike>;
  readonly ownerDocument?: {
    createElement(tagName: 'track'): VideoTrackElementLike;
  } | null;
  onloadedmetadata: (() => void) | null;
  ontimeupdate: (() => void) | null;
  onplay: (() => void) | null;
  onpause: (() => void) | null;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void> | void;
  pause(): void;
  load?(): void;
  removeAttribute(attr: string): void;
  appendChild(child: VideoTrackElementLike): void;
  querySelectorAll?(selector: 'track'): ArrayLike<VideoTrackElementLike>;
}

export interface HybridPlayerOptions {
  readonly webapis?: WebApisNamespace | null;
  readonly videoElement?: VideoElementLike | null;
  readonly onStateChange?: (state: HybridPlayerState) => void;
  readonly onTimeUpdate?: (currentTimeSec: number, durationSec: number) => void;
  readonly onSubtitleText?: (text: string) => void;
  readonly onError?: (errorMessage: string) => void;
}

export interface PlayerLoadOptions {
  readonly startTimeSec?: number;
  readonly forceBackend?: PlayerBackend;
}

export interface HybridPlayerInstance {
  readonly state: HybridPlayerState;
  load(item: PlayableMediaItem, startOptions?: PlayerLoadOptions): PlayerBackend;
  stop(): void;
  togglePlayPause(): PlayerStatus;
  seekRelative(deltaSeconds: number): number;
  toggleSubtitles(): boolean;
  cycleAspectMode(): AspectMode;
  cyclePlaybackRate(): number;
  cycleAudioTrack(): number;
  isAvPlayAvailable(): boolean;
}

export var ASPECT_MODES: readonly AspectMode[] = ['contain', 'cover', 'fill'];
export var PLAYBACK_RATES: readonly number[] = [0.75, 1.0, 1.25, 1.5, 2.0];

export function formatTime(seconds: number): string {
  var s: number = Math.max(0, Math.floor(Number(seconds) || 0));
  var hrs: number = Math.floor(s / 3600);
  var mins: number = Math.floor((s % 3600) / 60);
  var secs: number = s % 60;
  var mm: string = mins < 10 ? '0' + mins : String(mins);
  var ss: string = secs < 10 ? '0' + secs : String(secs);
  if (hrs > 0) {
    return hrs + ':' + mm + ':' + ss;
  }
  return mm + ':' + ss;
}

export function parseActionData(rawActionData: string): DeepLinkTarget | null {
  if (!rawActionData || typeof rawActionData !== 'string') {
    return null;
  }
  var trimmed: string = rawActionData.trim();
  var qIndex: number = trimmed.indexOf('?');
  var pathPart: string = qIndex !== -1 ? trimmed.slice(0, qIndex) : trimmed;
  var queryPart: string = qIndex !== -1 ? trimmed.slice(qIndex + 1) : '';
  var resumeSec = 0;

  if (queryPart) {
    var pairs: string[] = queryPart.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var pairStr = pairs[i];
      if (!pairStr) continue;
      var kv: string[] = pairStr.split('=');
      if (kv[0] === 't' && kv[1]) {
        resumeSec = Math.max(0, Number(kv[1]) || 0);
      }
    }
  }

  var segments: string[] = pathPart.split('/');
  var command: string = segments[0] || '';
  var itemId: string = segments.slice(1).join('/');
  if (!command || !itemId) {
    return null;
  }

  return {
    command: command,
    itemId: itemId,
    resumeSec: resumeSec
  };
}

export function extractDeepLinkFromEnvironment(
  tizenObj?: TizenNamespace | null,
  locationSearch?: string
): DeepLinkTarget | null {
  var tz: TizenNamespace | null =
    tizenObj !== undefined
      ? tizenObj
      : typeof tizen !== 'undefined'
        ? tizen
        : null;

  if (tz && tz.application && typeof tz.application.getCurrentApplication === 'function') {
    try {
      var reqCtrl = tz.application.getCurrentApplication().getRequestedAppControl();
      if (reqCtrl && reqCtrl.appControl && Array.isArray(reqCtrl.appControl.data)) {
        var dataArr = reqCtrl.appControl.data;
        for (var i = 0; i < dataArr.length; i++) {
          var entry = dataArr[i];
          if (entry && entry.key === 'PAYLOAD' && entry.value && entry.value.length > 0) {
            var rawVal: string = entry.value[0] || '';
            try {
              var parsed = JSON.parse(rawVal) as { values?: string };
              if (parsed && typeof parsed.values === 'string') {
                return parseActionData(parsed.values);
              }
            } catch (_e: unknown) {
              return parseActionData(rawVal);
            }
          }
        }
      }
    } catch (_e: unknown) {
      // Ignore if not running inside Tizen application context
    }
  }

  var search: string =
    locationSearch !== undefined
      ? locationSearch
      : typeof window !== 'undefined' && window.location
        ? window.location.search
        : '';

  if (search && search.length > 1) {
    var clean: string = search.charAt(0) === '?' ? search.slice(1) : search;
    var parts: string[] = clean.split('&');
    for (var j = 0; j < parts.length; j++) {
      var partStr = parts[j];
      if (!partStr) continue;
      var pair: string[] = partStr.split('=');
      if (pair[0] === 'action_data' && pair[1]) {
        return parseActionData(decodeURIComponent(pair[1]));
      }
    }
  }

  return null;
}

export function createHybridPlayer(options?: HybridPlayerOptions): HybridPlayerInstance {
  var opts: HybridPlayerOptions = options || {};
  var webapisObj: WebApisNamespace | null =
    opts.webapis !== undefined
      ? opts.webapis
      : typeof webapis !== 'undefined'
        ? webapis
        : null;
  var videoElement: VideoElementLike | null = opts.videoElement || null;
  var onStateChange = opts.onStateChange || function (): void {};
  var onTimeUpdate = opts.onTimeUpdate || function (): void {};
  var onSubtitleText = opts.onSubtitleText || function (): void {};
  var onError = opts.onError || function (): void {};

  var state: HybridPlayerState = {
    backend: 'html5',
    status: 'idle',
    currentTime: 0,
    duration: 0,
    subtitlesEnabled: true,
    aspectIndex: 0,
    aspectMode: ASPECT_MODES[0] || 'contain',
    rateIndex: 1,
    playbackRate: PLAYBACK_RATES[1] || 1.0,
    audioTracks: [],
    activeAudioTrackIndex: 0,
    item: null
  };

  function notifyState(): void {
    onStateChange(state);
  }

  function isAvPlayAvailable(): boolean {
    return Boolean(
      webapisObj && webapisObj.avplay && typeof webapisObj.avplay.open === 'function'
    );
  }

  function selectBackendForItem(
    item: PlayableMediaItem | null,
    forceBackend?: PlayerBackend
  ): PlayerBackend {
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

  function stop(): void {
    if (state.backend === 'avplay' && webapisObj && webapisObj.avplay) {
      try {
        webapisObj.avplay.stop();
        webapisObj.avplay.close();
      } catch (_e: unknown) {}
    }
    if (videoElement) {
      try {
        videoElement.pause();
        videoElement.removeAttribute('src');
        if (typeof videoElement.load === 'function') {
          videoElement.load();
        }
      } catch (_e: unknown) {}
    }
    state.status = 'idle';
    notifyState();
  }

  function load(item: PlayableMediaItem, startOptions?: PlayerLoadOptions): PlayerBackend {
    var sOpts: PlayerLoadOptions = startOptions || {};
    stop();

    state.item = item;
    state.currentTime = Number(sOpts.startTimeSec) || 0;
    state.duration = 0;
    state.status = 'loading';
    state.backend = selectBackendForItem(item, sOpts.forceBackend);
    notifyState();

    if (state.backend === 'avplay' && webapisObj && webapisObj.avplay) {
      var avplay = webapisObj.avplay;
      try {
        avplay.open(item.streamUrl);
        avplay.setDisplayRect(0, 0, 1920, 1080);
        avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');

        avplay.setListener({
          onbufferingstart: function (): void {
            state.status = 'loading';
            notifyState();
          },
          onbufferingcomplete: function (): void {
            state.status = 'playing';
            notifyState();
          },
          oncurrentplaytime: function (currentTimeMs: number): void {
            state.currentTime = Math.floor((Number(currentTimeMs) || 0) / 1000);
            onTimeUpdate(state.currentTime, state.duration);
          },
          onsubtitlechange: function (_durationMs: number, text: string): void {
            if (state.subtitlesEnabled) {
              onSubtitleText(text || '');
            }
          },
          onstreamcompleted: function (): void {
            state.status = 'ended';
            notifyState();
            avplay.stop();
          },
          onerror: function (errType: string): void {
            state.status = 'error';
            notifyState();
            onError('AVPlay Error: ' + String(errType));
          }
        });

        avplay.prepareAsync(
          function (): void {
            var durMs: number = avplay.getDuration ? avplay.getDuration() : 0;
            state.duration = Math.floor((Number(durMs) || 0) / 1000);

            if (typeof avplay.getTotalTrackInfo === 'function') {
              var tracks: readonly AVPlayTrackInfo[] = avplay.getTotalTrackInfo() || [];
              var audioList: AVPlayTrackInfo[] = [];
              for (var i = 0; i < tracks.length; i++) {
                var tr = tracks[i];
                if (tr && tr.type === 'AUDIO') {
                  audioList.push(tr);
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
          function (err: TizenError): void {
            state.status = 'error';
            notifyState();
            onError(
              'AVPlay prepareAsync failed: ' +
                (err && err.message ? err.message : String(err))
            );
          }
        );
        return state.backend;
      } catch (err: unknown) {
        var avMsg = err instanceof Error ? err.message : String(err);
        onError('AVPlay exception, falling back to HTML5 video: ' + avMsg);
        state.backend = 'html5';
      }
    }

    if (videoElement) {
      var vEl: VideoElementLike = videoElement;
      vEl.src = item.streamUrl;
      vEl.playbackRate = state.playbackRate;
      vEl.style.objectFit = state.aspectMode;

      var existingTracks = vEl.querySelectorAll ? vEl.querySelectorAll('track') : [];
      for (var t = 0; t < existingTracks.length; t++) {
        var trEl = existingTracks[t];
        if (trEl && trEl.parentNode) {
          trEl.parentNode.removeChild(trEl);
        }
      }

      if (item.subtitleUrl && vEl.ownerDocument) {
        var trackEl = vEl.ownerDocument.createElement('track');
        trackEl.kind = 'subtitles';
        trackEl.label = 'English';
        trackEl.srclang = 'en';
        trackEl.src = item.subtitleUrl;
        trackEl.default = state.subtitlesEnabled;
        vEl.appendChild(trackEl);
      }

      vEl.onloadedmetadata = function (): void {
        state.duration = Math.floor(Number(vEl.duration) || 0);
        if (state.currentTime > 0 && state.currentTime < state.duration) {
          vEl.currentTime = state.currentTime;
        }
        notifyState();
      };

      vEl.ontimeupdate = function (): void {
        state.currentTime = Math.floor(Number(vEl.currentTime) || 0);
        state.duration = Math.floor(Number(vEl.duration) || 0);
        onTimeUpdate(state.currentTime, state.duration);
      };

      vEl.onplay = function (): void {
        state.status = 'playing';
        notifyState();
      };

      vEl.onpause = function (): void {
        if (state.status !== 'idle' && state.status !== 'ended') {
          state.status = 'paused';
          notifyState();
        }
      };

      vEl.onended = function (): void {
        state.status = 'ended';
        notifyState();
      };

      vEl.onerror = function (): void {
        state.status = 'error';
        notifyState();
        onError('HTML5 video element failed to load stream: ' + item.streamUrl);
      };

      var playResult = vEl.play();
      if (playResult && typeof playResult.then === 'function') {
        playResult
          .then(function (): void {
            state.status = 'playing';
            notifyState();
          })
          .catch(function (): void {
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

  function togglePlayPause(): PlayerStatus {
    if (state.backend === 'avplay' && webapisObj && webapisObj.avplay) {
      try {
        if (state.status === 'playing') {
          webapisObj.avplay.pause();
          state.status = 'paused';
        } else {
          webapisObj.avplay.play();
          state.status = 'playing';
        }
        notifyState();
      } catch (_e: unknown) {}
      return state.status;
    }

    if (videoElement) {
      if (videoElement.paused) {
        void videoElement.play();
        state.status = 'playing';
      } else {
        videoElement.pause();
        state.status = 'paused';
      }
      notifyState();
    }
    return state.status;
  }

  function seekRelative(deltaSeconds: number): number {
    var delta: number = Number(deltaSeconds) || 0;
    var target: number = Math.max(0, state.currentTime + delta);
    if (state.duration > 0) {
      target = Math.min(state.duration, target);
    }

    if (state.backend === 'avplay' && webapisObj && webapisObj.avplay) {
      try {
        if (delta > 0 && webapisObj.avplay.jumpForward) {
          webapisObj.avplay.jumpForward(delta * 1000);
        } else if (delta < 0 && webapisObj.avplay.jumpBackward) {
          webapisObj.avplay.jumpBackward(Math.abs(delta) * 1000);
        }
        state.currentTime = target;
        notifyState();
      } catch (_e: unknown) {}
      return state.currentTime;
    }

    if (videoElement) {
      videoElement.currentTime = target;
      state.currentTime = target;
      notifyState();
    }
    return state.currentTime;
  }

  function toggleSubtitles(): boolean {
    state.subtitlesEnabled = !state.subtitlesEnabled;
    if (videoElement && videoElement.textTracks) {
      for (var i = 0; i < videoElement.textTracks.length; i++) {
        var track = videoElement.textTracks[i];
        if (track) {
          track.mode = state.subtitlesEnabled ? 'showing' : 'hidden';
        }
      }
    }
    if (!state.subtitlesEnabled) {
      onSubtitleText('');
    }
    notifyState();
    return state.subtitlesEnabled;
  }

  function cycleAspectMode(): AspectMode {
    state.aspectIndex = (state.aspectIndex + 1) % ASPECT_MODES.length;
    state.aspectMode = ASPECT_MODES[state.aspectIndex] || 'contain';
    if (videoElement && videoElement.style) {
      videoElement.style.objectFit = state.aspectMode;
    }
    notifyState();
    return state.aspectMode;
  }

  function cyclePlaybackRate(): number {
    state.rateIndex = (state.rateIndex + 1) % PLAYBACK_RATES.length;
    state.playbackRate = PLAYBACK_RATES[state.rateIndex] || 1.0;
    if (videoElement) {
      videoElement.playbackRate = state.playbackRate;
    }
    notifyState();
    return state.playbackRate;
  }

  function cycleAudioTrack(): number {
    if (
      state.backend === 'avplay' &&
      webapisObj &&
      webapisObj.avplay &&
      state.audioTracks.length > 1
    ) {
      state.activeAudioTrackIndex =
        (state.activeAudioTrackIndex + 1) % state.audioTracks.length;
      var track = state.audioTracks[state.activeAudioTrackIndex];
      if (track && webapisObj.avplay.setSelectTrack) {
        try {
          webapisObj.avplay.setSelectTrack('AUDIO', track.index);
        } catch (_e: unknown) {}
      }
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

if (typeof window !== 'undefined') {
  var win = window as unknown as Record<string, unknown>;
  win.OpenWebTVPlayer = {
    ASPECT_MODES: ASPECT_MODES,
    PLAYBACK_RATES: PLAYBACK_RATES,
    formatTime: formatTime,
    parseActionData: parseActionData,
    extractDeepLinkFromEnvironment: extractDeepLinkFromEnvironment,
    createHybridPlayer: createHybridPlayer
  };
  win.__OPEN_WEBTV_PLAYER_CAPABILITIES__ = {
    spatialNavigation: true,
    hlsSupport: true,
    avplayBridge: true
  };
}
