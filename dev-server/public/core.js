/* Open WebTV - Runtime Bootstrapper (core.js) */
(function (root) {
  'use strict';
  root.__OPEN_WEBTV_RUNTIME__ = {
    version: '1.0.0',
    bootedAt: new Date().toISOString()
  };
})(typeof window !== 'undefined' ? window : this);
