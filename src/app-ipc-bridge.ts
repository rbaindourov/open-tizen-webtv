/**
 * Open WebTV - Strictly Typed Foreground Tizen IPC & Hardware Key Bridge
 *
 * Manages communication between the foreground WebTV wrapper and the
 * Tizen Smart Hub Preview background service (`OSWebTVApp.service`),
 * as well as Samsung Smart TV remote control key registrations.
 */

import type {
  LoggerLike,
  TizenError,
  TizenKeyValueMessage,
  TizenLocalMessagePort,
  TizenNamespace,
  TizenRemoteMessagePort
} from './types/tizen.ts';

export interface IPCBridgeConfig {
  readonly clientAppId: string;
  readonly previewServiceId: string;
  readonly clientChannel: string;
  readonly serviceChannel: string;
  readonly previewFeedUrl: string;
}

export interface IPCBridgeOptions {
  readonly clientAppId?: string;
  readonly previewServiceId?: string;
  readonly clientChannel?: string;
  readonly serviceChannel?: string;
  readonly previewFeedUrl?: string;
  readonly tizen?: TizenNamespace | null;
  readonly logger?: LoggerLike;
}

export interface IPCBridgeInstance {
  readonly config: IPCBridgeConfig;
  registerRemoteKeys(): string[];
  initPreviewService(): boolean;
  sendPreviewFeedUrl(feedUrl?: string): boolean;
  onMessageReceived(data: readonly TizenKeyValueMessage[]): void;
  exitApplication(): boolean;
}

export var DEFAULT_CONFIG: IPCBridgeConfig = {
  clientAppId: 'OSWebTVApp.OpenWebTV',
  previewServiceId: 'OSWebTVApp.service',
  clientChannel: 'WEBTV_CLIENT_CHANNEL',
  serviceChannel: 'WEBTV_SERVICE_CHANNEL',
  previewFeedUrl: 'http://127.0.0.1:4000/preview.json'
};

export var MEDIA_KEYS: readonly string[] = [
  'MediaPlayPause',
  'MediaPlay',
  'MediaPause',
  'MediaStop',
  'MediaFastForward',
  'MediaRewind',
  'ColorF0Red',
  'ColorF1Green',
  'ColorF2Yellow',
  'ColorF3Blue',
  'Info'
];

export function createIPCBridge(options?: IPCBridgeOptions): IPCBridgeInstance {
  var opts: IPCBridgeOptions = options || {};
  var config: IPCBridgeConfig = {
    clientAppId: opts.clientAppId || DEFAULT_CONFIG.clientAppId,
    previewServiceId: opts.previewServiceId || DEFAULT_CONFIG.previewServiceId,
    clientChannel: opts.clientChannel || DEFAULT_CONFIG.clientChannel,
    serviceChannel: opts.serviceChannel || DEFAULT_CONFIG.serviceChannel,
    previewFeedUrl: opts.previewFeedUrl || DEFAULT_CONFIG.previewFeedUrl
  };

  var tizenApi: TizenNamespace | null =
    opts.tizen !== undefined
      ? opts.tizen
      : typeof tizen !== 'undefined'
        ? tizen
        : null;
  var logger: LoggerLike = opts.logger || console;
  var clientPort: TizenLocalMessagePort | null = null;
  var servicePort: TizenRemoteMessagePort | null = null;

  function registerRemoteKeys(): string[] {
    if (!tizenApi || !tizenApi.tvinputdevice) {
      return [];
    }
    var registered: string[] = [];
    for (var i = 0; i < MEDIA_KEYS.length; i++) {
      var keyName = MEDIA_KEYS[i];
      if (!keyName) continue;
      try {
        tizenApi.tvinputdevice.registerKey(keyName);
        registered.push(keyName);
      } catch (err: unknown) {
        var msg = err instanceof Error ? err.message : String(err);
        logger.warn('[AppIPCBridge] Failed to register key ' + keyName + ': ' + msg);
      }
    }
    return registered;
  }

  function sendPreviewFeedUrl(feedUrl?: string): boolean {
    var targetUrl: string = feedUrl || config.previewFeedUrl;
    if (!tizenApi || !tizenApi.messageport) {
      return false;
    }
    try {
      if (!servicePort) {
        servicePort = tizenApi.messageport.requestRemoteMessagePort(
          config.previewServiceId,
          config.serviceChannel
        );
      }
      servicePort.sendMessage([
        {
          key: 'SYNC_PREVIEW_FEED',
          value: targetUrl
        }
      ]);
      return true;
    } catch (err: unknown) {
      var msg = err instanceof Error ? err.message : String(err);
      logger.error('[AppIPCBridge] Failed sending SYNC_PREVIEW_FEED message: ' + msg);
      return false;
    }
  }

  function onMessageReceived(data: readonly TizenKeyValueMessage[]): void {
    if (!data || !data.length) {
      return;
    }
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      if (item && item.key === 'SERVICE_ONLINE') {
        sendPreviewFeedUrl(config.previewFeedUrl);
      }
    }
  }

  function initPreviewService(): boolean {
    if (!tizenApi || !tizenApi.messageport || !tizenApi.application) {
      return false;
    }

    try {
      clientPort = tizenApi.messageport.requestLocalMessagePort(config.clientChannel);
      clientPort.addMessagePortListener(onMessageReceived);
    } catch (err: unknown) {
      var chMsg = err instanceof Error ? err.message : String(err);
      logger.error('[AppIPCBridge] Failed initializing client message channel: ' + chMsg);
    }

    try {
      var AppControlCtor = tizenApi.ApplicationControl;
      var AppControlDataCtor = tizenApi.ApplicationControlData;
      if (!AppControlCtor || !AppControlDataCtor) {
        return false;
      }

      var appControl = new AppControlCtor(
        'http://tizen.org/appcontrol/operation/default',
        null,
        null,
        null,
        [new AppControlDataCtor('caller', ['OpenWebTVClient'])]
      );

      tizenApi.application.launchAppControl(
        appControl,
        config.previewServiceId,
        function (): void {
          logger.info(
            '[AppIPCBridge] Launched background service: ' + config.previewServiceId
          );
        },
        function (err: TizenError): void {
          logger.error('[AppIPCBridge] Background service launch failed: ' + err.message);
        }
      );
      return true;
    } catch (err: unknown) {
      var launchMsg = err instanceof Error ? err.message : String(err);
      logger.error('[AppIPCBridge] Exception launching background service: ' + launchMsg);
      return false;
    }
  }

  function exitApplication(): boolean {
    if (tizenApi && tizenApi.application) {
      try {
        tizenApi.application.getCurrentApplication().exit();
        return true;
      } catch (err: unknown) {
        var exitMsg = err instanceof Error ? err.message : String(err);
        logger.error('[AppIPCBridge] Exit error: ' + exitMsg);
      }
    }
    return false;
  }

  return {
    config: config,
    registerRemoteKeys: registerRemoteKeys,
    initPreviewService: initPreviewService,
    sendPreviewFeedUrl: sendPreviewFeedUrl,
    onMessageReceived: onMessageReceived,
    exitApplication: exitApplication
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).AppIPCBridge = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    MEDIA_KEYS: MEDIA_KEYS,
    createIPCBridge: createIPCBridge
  };
}
