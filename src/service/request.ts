/**
 * Open WebTV - Strictly Typed HTTP/HTTPS JSON Request Helper for Tizen Background Service
 *
 * Supports both `http://` (for local development/emulator feeds) and `https://`
 * (for production CDN feeds), validates HTTP status codes, and enforces timeouts.
 */

import http from 'node:http';
import https from 'node:https';
import urlModule from 'node:url';

export interface RequestOptions {
  readonly timeoutMs?: number;
}

export interface RequestError {
  readonly code: string;
  readonly message: string;
  readonly statusCode?: number;
}

var DEFAULT_TIMEOUT_MS = 8000;

export function get<T = unknown>(targetUrl: string, options?: RequestOptions): Promise<T> {
  var opts: RequestOptions = options || {};
  var timeoutMs: number =
    typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise<T>(function (
    resolve: (value: T) => void,
    reject: (reason: RequestError) => void
  ): void {
    if (!targetUrl || typeof targetUrl !== 'string') {
      reject({
        code: 'ERR_INVALID_URL',
        message: 'A valid URL string is required'
      });
      return;
    }

    var parsedUrl: { protocol?: string | null };
    try {
      parsedUrl =
        typeof URL !== 'undefined' ? new URL(targetUrl) : urlModule.parse(targetUrl);
    } catch (err: unknown) {
      var errMsg = err instanceof Error ? err.message : String(err);
      reject({
        code: 'ERR_INVALID_URL',
        message: errMsg
      });
      return;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      reject({
        code: 'ERR_UNSUPPORTED_PROTOCOL',
        message: 'Unsupported protocol: ' + String(parsedUrl.protocol)
      });
      return;
    }

    var transport = parsedUrl.protocol === 'https:' ? https : http;
    var settled = false;

    var req = transport.request(targetUrl, function (response: http.IncomingMessage): void {
      var statusCode: number = response.statusCode || 0;
      var responseString = '';

      response.on('data', function (chunk: Buffer | string): void {
        responseString += String(chunk);
      });

      response.on('end', function (): void {
        if (settled) {
          return;
        }
        settled = true;

        if (statusCode < 200 || statusCode >= 300) {
          reject({
            code: 'ERR_HTTP_STATUS',
            statusCode: statusCode,
            message: 'HTTP request failed with status ' + statusCode
          });
          return;
        }

        try {
          var parsedData = JSON.parse(responseString) as T;
          resolve(parsedData);
        } catch (parseErr: unknown) {
          var parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          reject({
            code: 'ERR_JSON_PARSE',
            message: 'Failed to parse JSON response: ' + parseMsg
          });
        }
      });
    });

    req.on('error', function (error: NodeJS.ErrnoException): void {
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
      req.setTimeout(timeoutMs, function (): void {
        if (settled) {
          return;
        }
        settled = true;
        req.destroy();
        reject({
          code: 'ERR_TIMEOUT',
          message: 'Request timed out after ' + timeoutMs + 'ms'
        });
      });
    }

    req.end();
  });
}

export { DEFAULT_TIMEOUT_MS };
