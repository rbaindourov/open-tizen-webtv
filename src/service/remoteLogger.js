/**
 * Open WebTV - Non-Blocking Telemetry Client for Tizen Background Service
 *
 * Dispatches diagnostic events over HTTP to the development server.
 * Fails silently if the development server is offline so it never interrupts
 * background service execution on retail TV hardware.
 */
'use strict';

var http = require('http');
var https = require('https');
var urlModule = require('url');
var defaultConfig = require('./config.json');

function createLogger(customConfig) {
  var cfg = customConfig || defaultConfig;
  var logServerOrigin = (cfg && cfg.logServerOrigin ? cfg.logServerOrigin : '').replace(/\/+$/, '');

  function dispatchTelemetry(targetUrl, onComplete) {
    if (!logServerOrigin) {
      if (onComplete) onComplete(null);
      return;
    }

    try {
      var parsed = typeof URL !== 'undefined' ? new URL(targetUrl) : urlModule.parse(targetUrl);
      var transport = parsed.protocol === 'https:' ? https : http;
      var req = transport.request(targetUrl, function (res) {
        res.on('data', function () {});
        res.on('end', function () {
          if (onComplete) onComplete(null);
        });
      });

      req.on('error', function (err) {
        if (onComplete) onComplete(err);
      });

      if (typeof req.setTimeout === 'function') {
        req.setTimeout(2500, function () {
          req.abort();
        });
      }

      req.end();
    } catch (err) {
      if (onComplete) onComplete(err);
    }
  }

  function log(message, data, onComplete) {
    var msgStr = encodeURIComponent(String(message || ''));
    var serializedData = '';
    if (data !== undefined) {
      try {
        serializedData = encodeURIComponent(JSON.stringify(data));
      } catch (err) {
        serializedData = encodeURIComponent(String(data));
      }
    }
    var targetUrl =
      logServerOrigin +
      '/log?level=info&message=' +
      msgStr +
      (serializedData ? '&data=' + serializedData : '');
    dispatchTelemetry(targetUrl, onComplete);
  }

  return {
    log: log,
    dispatchTelemetry: dispatchTelemetry
  };
}

var defaultInstance = createLogger(defaultConfig);

module.exports = {
  log: defaultInstance.log,
  createLogger: createLogger
};
