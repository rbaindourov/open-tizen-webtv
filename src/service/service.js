/**
 * Open WebTV - Samsung Smart Hub Preview (`bg_service`) Background Service
 *
 * Implements the three Tizen background service lifecycle hooks:
 * - `onStart`: Opens the service MessagePort (`WEBTV_SERVICE_CHANNEL`) and notifies the
 *              foreground client on `WEBTV_CLIENT_CHANNEL` via `{ key: 'SERVICE_ONLINE', value: true }`.
 * - `onRequest`: Handles direct service requests from the Tizen OS launcher daemon.
 * - `onExit`: Logs clean service shutdown.
 */
'use strict';

var httpClientModule = require('./request');
var telemetryLogger = require('./remoteLogger');
var defaultConfig = require('./config.json');

function validatePreviewPayload(previewData) {
  if (!previewData || typeof previewData !== 'object') {
    return false;
  }
  if (!Array.isArray(previewData.sections) || previewData.sections.length === 0) {
    return false;
  }
  for (var i = 0; i < previewData.sections.length; i++) {
    var section = previewData.sections[i];
    if (!section || !Array.isArray(section.tiles)) {
      return false;
    }
  }
  return true;
}

function createService(deps) {
  var d = deps || {};
  var config = d.config || defaultConfig;
  var httpClient = d.httpClient || d.ajax || httpClientModule;
  var logger = d.remoteLogger || telemetryLogger;
  var getTizen = function () {
    return d.tizen || (typeof tizen !== 'undefined' ? tizen : null);
  };
  var getWebapis = function () {
    return d.webapis || (typeof webapis !== 'undefined' ? webapis : null);
  };

  var serviceChannelPort = null;
  var clientChannelPort = null;

  /**
   * Passes validated preview JSON data to Samsung's `webapis.preview.setPreviewData` API
   * and exits the background service upon completion.
   */
  function publishLauncherTiles(previewData) {
    logger.log('Publishing launcher preview tiles', previewData);

    if (!validatePreviewPayload(previewData)) {
      logger.log('Launcher preview rejected: invalid schema', previewData);
      return false;
    }

    var webapisObj = getWebapis();
    var tizenObj = getTizen();

    if (!webapisObj || !webapisObj.preview || typeof webapisObj.preview.setPreviewData !== 'function') {
      logger.log('Launcher preview skipped: webapis.preview unavailable');
      return false;
    }

    try {
      webapisObj.preview.setPreviewData(
        JSON.stringify(previewData),
        function () {
          logger.log('Launcher preview tiles updated');
          if (tizenObj && tizenObj.application) {
            tizenObj.application.getCurrentApplication().exit();
          }
        },
        function (e) {
          logger.log('Launcher preview update error: ' + (e && e.message ? e.message : String(e)));
        }
      );
      return true;
    } catch (e) {
      logger.log('Launcher preview exception: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  /**
   * Fetches the preview JSON from the provided URL and updates the Smart Hub Preview ribbon.
   */
  function syncLauncherFeed(url) {
    return httpClient
      .get(url)
      .then(function (data) {
        logger.log('Fetched launcher preview feed', data);
        publishLauncherTiles(data);
        return data;
      })
      .catch(function (error) {
        logger.log('Failed fetching launcher preview feed', error);
        return null;
      });
  }

  /**
   * Callback for incoming messages on `WEBTV_SERVICE_CHANNEL` from the foreground client.
   */
  function handleChannelMessage(data, port) {
    logger.log('IPC message received on service channel', { data: data, port: port });
    if (!Array.isArray(data) || data.length === 0) {
      return;
    }
    var message = data[0];
    if (message && message.key === 'SYNC_PREVIEW_FEED' && message.value) {
      logger.log('Synchronizing preview feed from client request', message);
      syncLauncherFeed(message.value);
    }
  }

  /**
   * Registers the background service's local MessagePort (`WEBTV_SERVICE_CHANNEL`) and listener.
   */
  function openServiceChannel() {
    var tizenObj = getTizen();
    if (!tizenObj || !tizenObj.messageport) {
      logger.log('tizen.messageport unavailable during openServiceChannel');
      return null;
    }

    try {
      logger.log('Opening service message channel', config.serviceChannel);
      serviceChannelPort = tizenObj.messageport.requestLocalMessagePort(config.serviceChannel);
    } catch (e) {
      logger.log('Service channel open error: ' + e.message);
      return null;
    }

    try {
      serviceChannelPort.addMessagePortListener(handleChannelMessage);
    } catch (e) {
      logger.log('Service channel listener error: ' + e.message);
    }

    return serviceChannelPort;
  }

  /**
   * Connects to the foreground app's MessagePort (`WEBTV_CLIENT_CHANNEL`) and sends `SERVICE_ONLINE`.
   */
  function notifyClientReady() {
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
    } catch (e) {
      logger.log('Client channel connect error: ' + e.message);
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
    } catch (e) {
      logger.log('Client channel send error: ' + e.message);
    }

    return clientChannelPort;
  }

  function onStart() {
    logger.log('Service onStart');
    openServiceChannel();
    notifyClientReady();
  }

  function onRequest() {
    logger.log('Service onRequest');
  }

  function onExit() {
    logger.log('Service onExit');
  }

  return {
    onStart: onStart,
    onRequest: onRequest,
    onExit: onExit,
    syncLauncherFeed: syncLauncherFeed,
    publishLauncherTiles: publishLauncherTiles,
    handleChannelMessage: handleChannelMessage,
    openServiceChannel: openServiceChannel,
    notifyClientReady: notifyClientReady,
    validatePreviewPayload: validatePreviewPayload
  };
}

var defaultService = createService();

module.exports = {
  onStart: defaultService.onStart,
  onRequest: defaultService.onRequest,
  onExit: defaultService.onExit,
  syncLauncherFeed: defaultService.syncLauncherFeed,
  publishLauncherTiles: defaultService.publishLauncherTiles,
  handleChannelMessage: defaultService.handleChannelMessage,
  openServiceChannel: defaultService.openServiceChannel,
  notifyClientReady: defaultService.notifyClientReady,
  validatePreviewPayload: defaultService.validatePreviewPayload,
  createService: createService
};
