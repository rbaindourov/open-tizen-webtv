/**
 * Open WebTV - Strictly Typed Non-Blocking Telemetry Client for Tizen Background Service
 *
 * Dispatches diagnostic events over HTTP to the development server.
 * Fails silently if the development server is offline so it never interrupts
 * background service execution on retail TV hardware.
 */

import http from 'node:http';
import https from 'node:https';
import urlModule from 'node:url';
import defaultConfig from './config.json' with { type: 'json' };

export interface TelemetryLoggerConfig {
  readonly logServerOrigin?: string;
}

export type TelemetryCompletionCallback = (error: unknown) => void;

export interface TelemetryLogger {
  log(message: string, data?: unknown, onComplete?: TelemetryCompletionCallback): void;
  dispatchTelemetry(targetUrl: string, onComplete?: TelemetryCompletionCallback): void;
}

export function createLogger(customConfig?: TelemetryLoggerConfig): TelemetryLogger {
  var cfg: TelemetryLoggerConfig = customConfig || defaultConfig;
  var logServerOrigin: string = (
    cfg && cfg.logServerOrigin ? cfg.logServerOrigin : ''
  ).replace(/\/+$/, '');

  function dispatchTelemetry(
    targetUrl: string,
    onComplete?: TelemetryCompletionCallback
  ): void {
    if (!logServerOrigin) {
      if (onComplete) onComplete(null);
      return;
    }

    try {
      var parsed: { protocol?: string | null } =
        typeof URL !== 'undefined' ? new URL(targetUrl) : urlModule.parse(targetUrl);
      var transport = parsed.protocol === 'https:' ? https : http;
      var req = transport.request(targetUrl, function (res: http.IncomingMessage): void {
        res.on('data', function (): void {});
        res.on('end', function (): void {
          if (onComplete) onComplete(null);
        });
      });

      req.on('error', function (err: Error): void {
        if (onComplete) onComplete(err);
      });

      if (typeof req.setTimeout === 'function') {
        req.setTimeout(2500, function (): void {
          req.destroy();
        });
      }

      req.end();
    } catch (err: unknown) {
      if (onComplete) onComplete(err);
    }
  }

  function log(
    message: string,
    data?: unknown,
    onComplete?: TelemetryCompletionCallback
  ): void {
    var msgStr: string = encodeURIComponent(String(message || ''));
    var serializedData = '';
    if (data !== undefined) {
      try {
        serializedData = encodeURIComponent(JSON.stringify(data));
      } catch (_err: unknown) {
        serializedData = encodeURIComponent(String(data));
      }
    }
    var targetUrl: string =
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

var defaultInstance: TelemetryLogger = createLogger(defaultConfig);
var log: TelemetryLogger['log'] = defaultInstance.log;

export { log };
