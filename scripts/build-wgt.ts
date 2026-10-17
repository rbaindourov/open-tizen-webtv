/**
 * Open WebTV - Strictly Typed Asset Generator, TS-to-Tizen Transpiler & Unsigned .wgt Builder
 *
 * 1. Validates `src/config.xml` and `src/service/config.json`.
 * 2. Generates bespoke procedural `src/logo.png` (128x128 RGBA) and `src/background.png` (320x180 RGBA).
 * 3. Transpiles all TypeScript sources (`src/*.ts`, `src/service/*.ts`, and `dev-server/public/*.ts`) into
 *    Tizen 2.4+ ES5-compatible `.js` files inside `dist/wgt-staging/` and `dist/public/`.
 * 4. Packages `dist/OpenWebTV.wgt` (standard ZIP/WGT archive structure).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBackgroundPngBuffer,
  createLogoPngBuffer
} from '../dev-server/assets.ts';
import {
  transpileFileForTizenBrowser,
  transpileFileForTizenService
} from './transpile-tizen.ts';
import { validateProjectConfig } from './validate-config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WidgetAssetsResult {
  readonly logoPath: string;
  readonly backgroundPath: string;
}

export function ensureWidgetBinaryAssets(srcDir: string): WidgetAssetsResult {
  const logoPath = path.join(srcDir, 'logo.png');
  const backgroundPath = path.join(srcDir, 'background.png');

  fs.writeFileSync(logoPath, createLogoPngBuffer(128, 128));
  fs.writeFileSync(backgroundPath, createBackgroundPngBuffer(320, 180));

  return { logoPath, backgroundPath };
}

export function buildWgtPackage(rootDir?: string): string {
  const baseDir = rootDir ? path.resolve(rootDir) : path.resolve(__dirname, '..');
  const validation = validateProjectConfig(baseDir);
  if (!validation.valid) {
    throw new Error('Config validation failed: ' + validation.errors.join('; '));
  }

  const srcDir = path.join(baseDir, 'src');
  const distDir = path.join(baseDir, 'dist');
  const stagingDir = path.join(distDir, 'wgt-staging');
  const stagingServiceDir = path.join(stagingDir, 'service');
  const distPublicDir = path.join(distDir, 'public');

  ensureWidgetBinaryAssets(srcDir);

  fs.mkdirSync(stagingServiceDir, { recursive: true });
  fs.mkdirSync(distPublicDir, { recursive: true });

  // Copy static widget files
  for (const staticFile of ['config.xml', 'index.html', 'logo.png', 'background.png']) {
    fs.copyFileSync(path.join(srcDir, staticFile), path.join(stagingDir, staticFile));
  }
  for (const serviceStatic of ['config.json', 'sample.json']) {
    fs.copyFileSync(
      path.join(srcDir, 'service', serviceStatic),
      path.join(stagingServiceDir, serviceStatic)
    );
  }

  // Transpile foreground TypeScript files to Tizen browser JS
  for (const browserScript of ['app-ipc-bridge', 'manifest-loader']) {
    const jsCode = transpileFileForTizenBrowser(
      path.join(srcDir, `${browserScript}.ts`)
    );
    fs.writeFileSync(path.join(stagingDir, `${browserScript}.js`), jsCode, 'utf8');
  }

  // Transpile background service TypeScript files to Tizen CommonJS
  for (const serviceScript of ['service', 'request', 'remoteLogger']) {
    const jsCode = transpileFileForTizenService(
      path.join(srcDir, 'service', `${serviceScript}.ts`)
    );
    fs.writeFileSync(
      path.join(stagingServiceDir, `${serviceScript}.js`),
      jsCode,
      'utf8'
    );
  }
  fs.writeFileSync(
    path.join(stagingServiceDir, 'package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
    'utf8'
  );

  // Also emit compiled 10-foot UI bundles into dist/public/
  const publicSrcDir = path.join(baseDir, 'dev-server', 'public');
  fs.copyFileSync(
    path.join(publicSrcDir, 'styles.css'),
    path.join(distPublicDir, 'styles.css')
  );
  for (const pubScript of ['core', 'player', 'app']) {
    const jsCode = transpileFileForTizenBrowser(
      path.join(publicSrcDir, `${pubScript}.ts`)
    );
    fs.writeFileSync(path.join(distPublicDir, `${pubScript}.js`), jsCode, 'utf8');
  }

  const wgtPath = path.join(distDir, 'OpenWebTV.wgt');
  execFileSync(
    'zip',
    [
      '-q',
      wgtPath,
      'config.xml',
      'index.html',
      'logo.png',
      'background.png',
      'app-ipc-bridge.js',
      'manifest-loader.js',
      'service/config.json',
      'service/sample.json',
      'service/service.js',
      'service/request.js',
      'service/remoteLogger.js'
    ],
    { cwd: stagingDir }
  );

  return wgtPath;
}

const isMainModule =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);

if (isMainModule) {
  const output = buildWgtPackage();
  console.log('✓ Built unsigned Tizen widget package:', output);
}
