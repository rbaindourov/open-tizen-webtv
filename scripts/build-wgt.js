/**
 * Open WebTV - Icon Generator & Unsigned .wgt Archive Builder
 *
 * Ensures `src/logo.png` exists as a valid PNG icon and packages `src/`
 * into `dist/OpenWebTV.wgt` (standard ZIP/WGT archive structure).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { validateProjectConfig } = require('./validate-config');

function createSolidPngBuffer(width, height, r, g, b) {
  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
    }
    return (c ^ -1) >>> 0;
  }

  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC_TABLE[n] = c;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    const combined = Buffer.concat([typeBuf, data]);
    crcBuf.writeUInt32BE(crc32(combined), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = width * 4 + 1;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    rawData[rowStart] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      rawData[px] = r;
      rawData[px + 1] = g;
      rawData[px + 2] = b;
      rawData[px + 3] = 255;
    }
  }

  const idat = zlib.deflateSync(rawData);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function ensureLogoPng(srcDir) {
  const logoPath = path.join(srcDir, 'logo.png');
  if (!fs.existsSync(logoPath)) {
    const pngBuffer = createSolidPngBuffer(128, 128, 56, 189, 248);
    fs.writeFileSync(logoPath, pngBuffer);
  }
  return logoPath;
}

function buildWgtPackage(rootDir) {
  const baseDir = rootDir || path.resolve(__dirname, '..');
  const validation = validateProjectConfig(baseDir);
  if (!validation.valid) {
    throw new Error('Config validation failed: ' + validation.errors.join('; '));
  }

  const srcDir = path.join(baseDir, 'src');
  const distDir = path.join(baseDir, 'dist');
  ensureLogoPng(srcDir);

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const wgtPath = path.join(distDir, 'OpenWebTV.wgt');
  execFileSync(
    'zip',
    ['-r', '-q', wgtPath, 'config.xml', 'index.html', 'logo.png', 'app-ipc-bridge.js', 'manifest-loader.js', 'service'],
    { cwd: srcDir }
  );

  return wgtPath;
}

if (require.main === module) {
  const output = buildWgtPackage();
  console.log('✓ Built unsigned Tizen widget package:', output);
}

module.exports = {
  ensureLogoPng,
  buildWgtPackage
};
