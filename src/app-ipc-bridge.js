/**
 * Open WebTV - Foreground Tizen IPC & Hardware Key Bridge
 *
 * Manages communication between the foreground WebTV wrapper and the
 * Tizen Smart Hub Preview background service (`OSWebTVApp.service`),
 * as well as Samsung Smart TV remote control key registrations.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AppIPCBridge = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_CONFIG = {
    clientAppId: 'OSWebTVApp.OpenWebTV',
    previewServiceId: 'OSWebTVApp.service',
    clientChannel: 'WEBTV_CLIENT_CHANNEL',
    serviceChannel: 'WEBTV_SERVICE_CHANNEL',
    previewFeedUrl: 'http://127.0.0.1:4000/preview.json'
  };

  var MEDIA_KEYS = [
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

  function createIPCBridge(options) {
    var opts = options || {};
    var config = {
      clientAppId: opts.clientAppId || DEFAULT_CONFIG.clientAppId,
      previewServiceId: opts.previewServiceId || DEFAULT_CONFIG.previewServiceId,
      clientChannel: opts.clientChannel || DEFAULT_CONFIG.clientChannel,
      serviceChannel: opts.serviceChannel || DEFAULT_CONFIG.serviceChannel,
      previewFeedUrl: opts.previewFeedUrl || DEFAULT_CONFIG.previewFeedUrl
    };

    var tizenApi = opts.tizen || (typeof tizen !== 'undefined' ? tizen : null);
    var logger = opts.logger || console;
    var clientPort = null;
    var servicePort = null;

    /**
     * Registers standard Samsung TV remote media keys so the web app receives keydown events.
     */
    function registerRemoteKeys() {
      if (!tizenApi || !tizenApi.tvinputdevice) {
        return [];
      }
      var registered = [];
      for (var i = 0; i < MEDIA_KEYS.length; i++) {
        var keyName = MEDIA_KEYS[i];
        try {
          tizenApi.tvinputdevice.registerKey(keyName);
          registered.push(keyName);
        } catch (err) {
          logger.warn('[AppIPCBridge] Failed to register key ' + keyName + ': ' + err.message);
        }
      }
      return registered;
    }

    /**
     * Sends the Smart Hub Preview JSON endpoint URL to the background service via MessagePort.
     */
    function sendPreviewFeedUrl(feedUrl) {
      var targetUrl = feedUrl || config.previewFeedUrl;
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
      } catch (err) {
        logger.error('[AppIPCBridge] Failed sending SYNC_PREVIEW_FEED message: ' + err.message);
        return false;
      }
    }

    /**
     * Handles incoming messages on `WEBTV_CLIENT_CHANNEL` from the background service.
     */
    function onMessageReceived(data) {
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

    /**
     * Opens the foreground local MessagePort (`WEBTV_CLIENT_CHANNEL`) and launches the background service.
     */
    function initPreviewService() {
      if (!tizenApi || !tizenApi.messageport || !tizenApi.application) {
        return false;
      }

      try {
        clientPort = tizenApi.messageport.requestLocalMessagePort(config.clientChannel);
        clientPort.addMessagePortListener(onMessageReceived);
      } catch (err) {
        logger.error('[AppIPCBridge] Failed initializing client message channel: ' + err.message);
      }

      try {
        var appControl = new tizenApi.ApplicationControl(
          'http://tizen.org/appcontrol/operation/default',
          null,
          null,
          null,
          [new tizenApi.ApplicationControlData('caller', ['OpenWebTVClient'])]
        );

        tizenApi.application.launchAppControl(
          appControl,
          config.previewServiceId,
          function () {
            logger.info('[AppIPCBridge] Launched background service: ' + config.previewServiceId);
          },
          function (err) {
            logger.error('[AppIPCBridge] Background service launch failed: ' + err.message);
          }
        );
        return true;
      } catch (err) {
        logger.error('[AppIPCBridge] Exception launching background service: ' + err.message);
        return false;
      }
    }

    /**
     * Exits the Tizen application cleanly.
     */
    function exitApplication() {
      if (tizenApi && tizenApi.application) {
        try {
          tizenApi.application.getCurrentApplication().exit();
          return true;
        } catch (err) {
          logger.error('[AppIPCBridge] Exit error: ' + err.message);
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

  return {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    MEDIA_KEYS: MEDIA_KEYS,
    createIPCBridge: createIPCBridge
  };
});
