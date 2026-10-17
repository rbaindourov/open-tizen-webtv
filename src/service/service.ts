/**
 * Open WebTV - Strictly Typed Samsung Smart Hub Preview (`bg_service`) Background Service
 *
 * Implements the three Tizen background service lifecycle hooks:
 * - `onStart`: Opens the service MessagePort (`WEBTV_SERVICE_CHANNEL`) and notifies the
 *              foreground client on `WEBTV_CLIENT_CHANNEL` via `{ key: 'SERVICE_ONLINE', value: true }`.
 * - `onRequest`: Handles direct service requests from the Tizen OS launcher daemon.
 * - `onExit`: Logs clean service shutdown.
 */

import * as httpClientModule from './request.ts';
import * as telemetryLogger from './remoteLogger.ts';
import defaultConfig from './config.json' with { type: 'json' };
import type {
  ServiceConfig,
  SmartHubPreviewPayload,
  TizenError,
  TizenKeyValueMessage,
  TizenLocalMessagePort,
  TizenNamespace,
  TizenRemoteMessagePort,
  WebApisNamespace
} from '../types/tizen.ts';

export interface HttpClientLike {
  get<T = unknown>(url: string): Promise<T>;
}

export interface RemoteLoggerLike {
  log(message: string, data?: unknown): void;
}

export interface ServiceDependencies {
  readonly config?: Partial<ServiceConfig>;
  readonly httpClient?: HttpClientLike;
  readonly ajax?: HttpClientLike;
  readonly remoteLogger?: RemoteLoggerLike;
  readonly tizen?: TizenNamespace | null;
  readonly webapis?: WebApisNamespace | null;
}

export interface TizenBackgroundServiceInstance {
  onStart(): void;
  onRequest(): void;
  onExit(): void;
  openServiceChannel(): TizenLocalMessagePort | null;
  notifyClientReady(): TizenRemoteMessagePort | null;
  handleChannelMessage(
    data: readonly TizenKeyValueMessage[],
    port?: TizenRemoteMessagePort | null
  ): void;
  syncLauncherFeed(url: string): Promise<SmartHubPreviewPayload | null>;
  publishLauncherTiles(previewData: unknown): boolean;
}

export function validatePreviewPayload(previewData: unknown): previewData is SmartHubPreviewPayload {
  if (!previewData || typeof previewData !== 'object') {
    return false;
  }
  var candidate = previewData as { sections?: unknown };
  if (!Array.isArray(candidate.sections) || candidate.sections.length === 0) {
    return false;
  }
  for (var i = 0; i < candidate.sections.length; i++) {
    var section = candidate.sections[i] as { tiles?: unknown } | undefined;
    if (!section || !Array.isArray(section.tiles)) {
      return false;
    }
  }
  return true;
}

export function createService(deps?: ServiceDependencies): TizenBackgroundServiceInstance {
  var d: ServiceDependencies = deps || {};
  var config: ServiceConfig = {
    logServerOrigin:
      (d.config && d.config.logServerOrigin) || defaultConfig.logServerOrigin,
    clientAppId: (d.config && d.config.clientAppId) || defaultConfig.clientAppId,
    previewServiceId:
      (d.config && d.config.previewServiceId) || defaultConfig.previewServiceId,
    clientChannel: (d.config && d.config.clientChannel) || defaultConfig.clientChannel,
    serviceChannel: (d.config && d.config.serviceChannel) || defaultConfig.serviceChannel,
    defaultFeedUrl: (d.config && d.config.defaultFeedUrl) || defaultConfig.defaultFeedUrl
  };
  var httpClient: HttpClientLike = d.httpClient || d.ajax || httpClientModule;
  var logger: RemoteLoggerLike = d.remoteLogger || telemetryLogger;

  var getTizen = function (): TizenNamespace | null {
    if (d.tizen !== undefined) {
      return d.tizen;
    }
    return typeof tizen !== 'undefined' ? tizen : null;
  };

  var getWebapis = function (): WebApisNamespace | null {
    if (d.webapis !== undefined) {
      return d.webapis;
    }
    return typeof webapis !== 'undefined' ? webapis : null;
  };

  var serviceChannelPort: TizenLocalMessagePort | null = null;
  var clientChannelPort: TizenRemoteMessagePort | null = null;

  function publishLauncherTiles(previewData: unknown): boolean {
    logger.log('Publishing launcher preview tiles', previewData);

    if (!validatePreviewPayload(previewData)) {
      logger.log('Launcher preview rejected: invalid schema', previewData);
      return false;
    }

    var webapisObj = getWebapis();
    var tizenObj = getTizen();

    if (
      !webapisObj ||
      !webapisObj.preview ||
      typeof webapisObj.preview.setPreviewData !== 'function'
    ) {
      logger.log('Launcher preview skipped: webapis.preview unavailable');
      return false;
    }

    try {
      webapisObj.preview.setPreviewData(
        JSON.stringify(previewData),
        function (): void {
          logger.log('Launcher preview tiles updated');
          if (tizenObj && tizenObj.application) {
            tizenObj.application.getCurrentApplication().exit();
          }
        },
        function (e: TizenError): void {
          logger.log(
            'Launcher preview update error: ' + (e && e.message ? e.message : String(e))
          );
        }
      );
      return true;
    } catch (e: unknown) {
      var msg = e instanceof Error ? e.message : String(e);
      logger.log('Launcher preview exception: ' + msg);
      return false;
    }
  }

  function syncLauncherFeed(url: string): Promise<SmartHubPreviewPayload | null> {
    return httpClient
      .get<SmartHubPreviewPayload>(url)
      .then(function (data: SmartHubPreviewPayload): SmartHubPreviewPayload {
        logger.log('Fetched launcher preview feed', data);
        publishLauncherTiles(data);
        return data;
      })
      .catch(function (error: unknown): null {
        logger.log('Failed fetching launcher preview feed', error);
        return null;
      });
  }

  function handleChannelMessage(
    data: readonly TizenKeyValueMessage[],
    port?: TizenRemoteMessagePort | null
  ): void {
    logger.log('IPC message received on service channel', { data: data, port: port });
    if (!Array.isArray(data) || data.length === 0) {
      return;
    }
    var message = data[0];
    if (
      message &&
      message.key === 'SYNC_PREVIEW_FEED' &&
      typeof message.value === 'string' &&
      message.value.length > 0
    ) {
      logger.log('Synchronizing preview feed from client request', message);
      void syncLauncherFeed(message.value);
    }
  }

  function openServiceChannel(): TizenLocalMessagePort | null {
    var tizenObj = getTizen();
    if (!tizenObj || !tizenObj.messageport) {
      logger.log('tizen.messageport unavailable during openServiceChannel');
      return null;
    }

    try {
      logger.log('Opening service message channel', config.serviceChannel);
      serviceChannelPort = tizenObj.messageport.requestLocalMessagePort(
        config.serviceChannel
      );
    } catch (e: unknown) {
      var errMsg = e instanceof Error ? e.message : String(e);
      logger.log('Service channel open error: ' + errMsg);
      return null;
    }

    try {
      serviceChannelPort.addMessagePortListener(handleChannelMessage);
    } catch (e: unknown) {
      var listErr = e instanceof Error ? e.message : String(e);
      logger.log('Service channel listener error: ' + listErr);
    }

    return serviceChannelPort;
  }

  function notifyClientReady(): TizenRemoteMessagePort | null {
    var tizenObj = getTizen();
    if (!tizenObj || !tizenObj.messageport) {
      logger.log('tizen.messageport unavailable during notifyClientReady');
      return null;
    }

    try {
      if (!clientChannelPort) {
        clientChannelPort = tizenObj.messageport.requestRemoteMessagePort(
          config.clientAppId,
          config.clientChannel
        );
      }
    } catch (e: unknown) {
      var connMsg = e instanceof Error ? e.message : String(e);
      logger.log('Client channel connect error: ' + connMsg);
      return null;
    }

    try {
      logger.log('Sending SERVICE_ONLINE handshake to client app');
      clientChannelPort.sendMessage([
        {
          key: 'SERVICE_ONLINE',
          value: true
        }
      ]);
    } catch (e: unknown) {
      var sendMsg = e instanceof Error ? e.message : String(e);
      logger.log('Client channel send error: ' + sendMsg);
    }

    return clientChannelPort;
  }

  function onStart(): void {
    logger.log('Service onStart');
    openServiceChannel();
    notifyClientReady();
  }

  function onRequest(): void {
    logger.log('Service onRequest');
  }

  function onExit(): void {
    logger.log('Service onExit');
  }

  return {
    onStart: onStart,
    onRequest: onRequest,
    onExit: onExit,
    openServiceChannel: openServiceChannel,
    notifyClientReady: notifyClientReady,
    handleChannelMessage: handleChannelMessage,
    syncLauncherFeed: syncLauncherFeed,
    publishLauncherTiles: publishLauncherTiles
  };
}

var defaultService: TizenBackgroundServiceInstance = createService();
var onStart: TizenBackgroundServiceInstance['onStart'] = defaultService.onStart;
var onRequest: TizenBackgroundServiceInstance['onRequest'] = defaultService.onRequest;
var onExit: TizenBackgroundServiceInstance['onExit'] = defaultService.onExit;
var syncLauncherFeed: TizenBackgroundServiceInstance['syncLauncherFeed'] =
  defaultService.syncLauncherFeed;
var publishLauncherTiles: TizenBackgroundServiceInstance['publishLauncherTiles'] =
  defaultService.publishLauncherTiles;

export {
  onStart,
  onRequest,
  onExit,
  syncLauncherFeed,
  publishLauncherTiles
};
