/**
 * Open WebTV - HTTP/HTTPS JSON Request Helper for Tizen Background Service
 *
 * Supports both `http://` (for local development/emulator feeds) and `https://`
 * (for production CDN feeds), validates HTTP status codes, and enforces timeouts.
 */
'use strict';

var http = require('http');
var https = require('https');
var urlModule = require('url');

var DEFAULT_TIMEOUT_MS = 8000;

function get(targetUrl, options) {
  var opts = options || {};
  var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise(function (resolve, reject) {
    if (!targetUrl || typeof targetUrl !== 'string') {
      return reject({
        code: 'ERR_INVALID_URL',
        message: 'A valid URL string is required'
      });
    }

    var parsedUrl;
    try {
      parsedUrl = typeof URL !== 'undefined' ? new URL(targetUrl) : urlModule.parse(targetUrl);
    } catch (err) {
      return reject({
        code: 'ERR_INVALID_URL',
        message: err.message
      });
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return reject({
        code: 'ERR_UNSUPPORTED_PROTOCOL',
        message: 'Unsupported protocol: ' + parsedUrl.protocol
      });
    }

    var transport = parsedUrl.protocol === 'https:' ? https : http;
    var settled = false;

    var req = transport.request(targetUrl, function (response) {
      var statusCode = response.statusCode || 0;
      var responseString = '';

      response.on('data', function (chunk) {
        responseString += chunk;
      });

      response.on('end', function () {
        if (settled) {
          return;
        }
        settled = true;

        if (statusCode < 200 || statusCode >= 300) {
          return reject({
            code: 'ERR_HTTP_STATUS',
            statusCode: statusCode,
            message: 'HTTP request failed with status ' + statusCode
          });
        }

        try {
          var parsedData = JSON.parse(responseString);
          resolve(parsedData);
        } catch (parseErr) {
          reject({
            code: 'ERR_JSON_PARSE',
            message: 'Failed to parse JSON response: ' + parseErr.message
          });
        }
      });
    });

    req.on('error', function (error) {
      if (settled) {
        return;
      }
      settled = true;
      reject({
        code: error.code || 'ERR_NETWORK',
        message: error.message || 'Network request failed'
      });
    });

    if (timeoutMs > 0 && typeof req.setTimeout === 'function') {
      req.setTimeout(timeoutMs, function () {
        if (settled) {
          return;
        }
        settled = true;
        req.abort();
        reject({
          code: 'ERR_TIMEOUT',
          message: 'Request timed out after ' + timeoutMs + 'ms'
        });
      });
    }

    req.end();
  });
}

module.exports = {
  get: get
};
