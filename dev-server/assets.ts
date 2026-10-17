/**
 * Open WebTV - Strictly Typed Procedural PNG & Unique Vector Background/Poster Generator
 *
 * Ensures every visual asset in Open WebTV is 100% original, deterministic, and unique:
 * - `createLogoPngBuffer()`: Multi-layer 128x128 RGBA PNG app icon with rounded bezel,
 *   cyan-indigo gradient screen, and play-prism emblem.
 * - `createBackgroundPngBuffer()`: 320x180 (16:9) RGBA PNG ambient cinema background with
 *   aurora waves and radial spotlight for the Tizen widget package (`src/background.png`).
 * - `renderAmbientBackgroundSvg()`: 1920x1080 vector ambient background for the 10-foot UI.
 * - `renderPosterSvg()` & `renderBackdropSvg()`: Distinct custom scene geometry for each
 *   built-in open stream and SHA-256 hash-seeded unique palettes & vector motifs for every
 *   SMB movie, M3U channel, and custom stream.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { CatalogItem } from './types.ts';

export type PixelGenerator = (
  x: number,
  y: number,
  width: number,
  height: number
) => readonly [number, number, number, number];

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const tableVal = CRC_TABLE[(c ^ byte) & 0xff] ?? 0;
    c = (c >>> 8) ^ tableVal;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodeProceduralPng(
  width: number,
  height: number,
  pixelFn: PixelGenerator
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowSize = width * 4 + 1;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    rawData[rowStart] = 0; // filter mode 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const px = rowStart + 1 + x * 4;
      rawData[px] = Math.max(0, Math.min(255, Math.round(r)));
      rawData[px + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rawData[px + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rawData[px + 3] = Math.max(0, Math.min(255, Math.round(a)));
    }
  }

  const idat = zlib.deflateSync(rawData);
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Generates the bespoke 128x128 RGBA `src/logo.png` icon:
 * - Rounded obsidian outer badge with glowing cyan-to-violet border
 * - Inner TV screen bezel with diagonal aurora gradient
 * - Crisp white play-prism triangle in the center
 */
export function createLogoPngBuffer(width = 128, height = 128): Buffer {
  return encodeProceduralPng(width, height, (x, y, w, h) => {
    const nx = x / (w - 1);
    const ny = y / (h - 1);
    const cx = (x - w / 2) / (w / 2);
    const cy = (y - h / 2) / (h / 2);

    // Superellipse rounded square boundary
    const superDist = Math.pow(Math.abs(cx), 4.5) + Math.pow(Math.abs(cy), 4.5);
    if (superDist > 0.96) {
      return [0, 0, 0, 0];
    }

    // Glowing outer border ring
    if (superDist > 0.78) {
      const r = 14 + nx * 85;
      const g = 165 - ny * 60;
      const b = 233 + ny * 20;
      return [r, g, b, 255];
    }

    // Center play triangle inside TV frame: x in [0.38, 0.68], y symmetric around 0.5
    const triProgress = (nx - 0.38) / 0.30;
    const halfSpan = 0.18 * (1 - triProgress);
    if (triProgress >= 0 && triProgress <= 1 && Math.abs(ny - 0.5) <= halfSpan) {
      const shade = 240 + (1 - triProgress) * 15;
      return [shade, 248, 255, 255];
    }

    // Subtle concentric sonar ring around play emblem
    const rad = Math.sqrt(cx * cx + cy * cy);
    if (Math.abs(rad - 0.52) < 0.025) {
      return [56, 189, 248, 255];
    }

    // Deep midnight-indigo to cyan screen interior gradient with subtle scanline
    const scanline = y % 3 === 0 ? 0.92 : 1.0;
    const r = (12 + nx * 28 + ny * 18) * scanline;
    const g = (20 + (1 - ny) * 42 + nx * 24) * scanline;
    const b = (42 + (1 - nx * 0.5) * 76 + ny * 30) * scanline;
    return [r, g, b, 255];
  });
}

/**
 * Generates the bespoke 320x180 (16:9) RGBA `src/background.png` cinema backdrop:
 * - Deep obsidian-indigo base with aurora sine-wave ribbons and perspective stage grid
 */
export function createBackgroundPngBuffer(width = 320, height = 180): Buffer {
  return encodeProceduralPng(width, height, (x, y, w, h) => {
    const nx = x / (w - 1);
    const ny = y / (h - 1);

    // Aurora wave ribbon
    const wave1 = Math.sin(nx * Math.PI * 2.5 + 0.4) * 0.14 + 0.38;
    const wave2 = Math.cos(nx * Math.PI * 1.8 - 0.7) * 0.12 + 0.62;
    const dist1 = Math.exp(-Math.pow((ny - wave1) / 0.16, 2));
    const dist2 = Math.exp(-Math.pow((ny - wave2) / 0.18, 2));

    // Radial stage spotlight at top-right
    const dx = nx - 0.78;
    const dy = ny - 0.24;
    const spot = Math.exp(-(dx * dx + dy * dy) / 0.12);

    // Subtle perspective grid in lower third
    let gridBoost = 0;
    if (ny > 0.68 && (y % 9 === 0 || (x + Math.floor(y * 0.6)) % 24 === 0)) {
      gridBoost = 14;
    }

    const r = 9 + dist1 * 18 + dist2 * 48 + spot * 26 + gridBoost;
    const g = 14 + dist1 * 68 + dist2 * 24 + spot * 74 + gridBoost;
    const b = 26 + dist1 * 110 + dist2 * 88 + spot * 115 + gridBoost * 1.5;

    return [r, g, b, 255];
  });
}

/**
 * Generates the high-resolution 1920x1080 `/assets/background.svg` ambient cinema backdrop
 * used by the Tizen boot screen and 10-foot Media Center shell.
 */
export function renderAmbientBackgroundSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="bg-base" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#050811" />
      <stop offset="45%" stop-color="#0b1325" />
      <stop offset="100%" stop-color="#070b16" />
    </linearGradient>
    <radialGradient id="aurora-cyan" cx="78%" cy="22%" r="55%">
      <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.22" />
      <stop offset="55%" stop-color="#0284c7" stop-opacity="0.07" />
      <stop offset="100%" stop-color="#050811" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="aurora-indigo" cx="18%" cy="76%" r="50%">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.18" />
      <stop offset="60%" stop-color="#312e81" stop-opacity="0.06" />
      <stop offset="100%" stop-color="#050811" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="wave-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.0" />
      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.24" />
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0.0" />
    </linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#bg-base)" />
  <rect width="1920" height="1080" fill="url(#aurora-cyan)" />
  <rect width="1920" height="1080" fill="url(#aurora-indigo)" />
  <path d="M 0 340 C 480 210, 960 470, 1440 290 C 1680 200, 1820 260, 1920 230 L 1920 1080 L 0 1080 Z" fill="#0f172a" fill-opacity="0.32" />
  <path d="M 0 340 C 480 210, 960 470, 1440 290 C 1680 200, 1820 260, 1920 230" fill="none" stroke="url(#wave-stroke)" stroke-width="2.5" />
  <path d="M 0 680 C 520 560, 1080 810, 1920 610" fill="none" stroke="url(#wave-stroke)" stroke-width="1.5" />
  <circle cx="1520" cy="240" r="280" fill="none" stroke="#38bdf8" stroke-opacity="0.07" stroke-width="1.5" />
  <circle cx="1520" cy="240" r="410" fill="none" stroke="#6366f1" stroke-opacity="0.05" stroke-width="1" />
</svg>`;
}

interface BuiltInPosterTheme {
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly accentColor: string;
  readonly title: string;
  readonly badge: string;
  readonly motifSvg: string;
}

const BUILTIN_THEMES: Readonly<Record<string, BuiltInPosterTheme>> = {
  'big-buck-bunny': {
    primaryColor: '#065f46',
    secondaryColor: '#0284c7',
    accentColor: '#34d399',
    title: 'Big Buck Bunny',
    badge: '1080p • H.264 • Open Movie',
    // Rolling emerald meadow hills & golden sunbeams
    motifSvg: `
      <circle cx="520" cy="88" r="76" fill="#fde047" fill-opacity="0.22" />
      <circle cx="520" cy="88" r="44" fill="#fef08a" fill-opacity="0.32" />
      <path d="M 0 260 Q 190 180 390 250 T 640 220 L 640 360 L 0 360 Z" fill="#047857" fill-opacity="0.38" />
      <path d="M 0 295 Q 260 225 480 290 T 640 270 L 640 360 L 0 360 Z" fill="#10b981" fill-opacity="0.22" />
    `
  },
  sintel: {
    primaryColor: '#4c1d95',
    secondaryColor: '#9d174d',
    accentColor: '#e879f9',
    title: 'Sintel',
    badge: '1080p • H.264 • Fantasy',
    // Jagged dragon mountain peaks & glowing embers
    motifSvg: `
      <polygon points="340,360 470,95 610,360" fill="#701a75" fill-opacity="0.42" />
      <polygon points="430,360 555,130 660,360" fill="#a21caf" fill-opacity="0.32" />
      <circle cx="485" cy="115" r="8" fill="#f0abfc" fill-opacity="0.65" />
      <circle cx="535" cy="85" r="5" fill="#f9a8d4" fill-opacity="0.55" />
      <circle cx="580" cy="145" r="6" fill="#f0abfc" fill-opacity="0.45" />
    `
  },
  'tears-of-steel': {
    primaryColor: '#115e59',
    secondaryColor: '#0f172a',
    accentColor: '#2dd4bf',
    title: 'Tears of Steel',
    badge: '1080p • Sci-Fi • Open Project',
    // Cybernetic holographic HUD targeting rings & grid lines
    motifSvg: `
      <circle cx="515" cy="135" r="98" fill="none" stroke="#2dd4bf" stroke-opacity="0.28" stroke-width="3" stroke-dasharray="18 10" />
      <circle cx="515" cy="135" r="64" fill="none" stroke="#5eead4" stroke-opacity="0.35" stroke-width="2" />
      <circle cx="515" cy="135" r="24" fill="#14b8a6" fill-opacity="0.25" />
      <line x1="395" y1="135" x2="635" y2="135" stroke="#2dd4bf" stroke-opacity="0.22" stroke-width="1.5" />
      <line x1="515" y1="25" x2="515" y2="245" stroke="#2dd4bf" stroke-opacity="0.22" stroke-width="1.5" />
    `
  },
  'elephants-dream': {
    primaryColor: '#78350f',
    secondaryColor: '#1e1b4b',
    accentColor: '#fbbf24',
    title: 'Elephants Dream',
    badge: '1080p • H.264 • Open Movie',
    // Industrial machine clockwork conduit & concentric gear rings
    motifSvg: `
      <rect x="425" y="45" width="160" height="160" rx="24" transform="rotate(18 505 125)" fill="none" stroke="#f59e0b" stroke-opacity="0.28" stroke-width="4" />
      <rect x="445" y="65" width="120" height="120" rx="16" transform="rotate(-12 505 125)" fill="none" stroke="#fbbf24" stroke-opacity="0.34" stroke-width="2.5" />
      <circle cx="505" cy="125" r="38" fill="#d97706" fill-opacity="0.26" />
    `
  },
  'cosmos-laundromat': {
    primaryColor: '#1e3a8a',
    secondaryColor: '#311042',
    accentColor: '#60a5fa',
    title: 'Cosmos Laundromat',
    badge: '1080p • H.264 • Sci-Fi Comedy',
    // Cosmic vortex ellipses & starfield
    motifSvg: `
      <ellipse cx="510" cy="125" rx="115" ry="52" transform="rotate(-24 510 125)" fill="none" stroke="#60a5fa" stroke-opacity="0.34" stroke-width="3" />
      <ellipse cx="510" cy="125" rx="75" ry="32" transform="rotate(-24 510 125)" fill="#3b82f6" fill-opacity="0.22" />
      <circle cx="430" cy="70" r="4" fill="#93c5fd" fill-opacity="0.7" />
      <circle cx="585" cy="175" r="5" fill="#c4b5fd" fill-opacity="0.7" />
    `
  },
  spring: {
    primaryColor: '#14532d',
    secondaryColor: '#064e3b',
    accentColor: '#4ade80',
    title: 'Spring',
    badge: '1080p • H.264 • Poetic Fantasy',
    // Enchanted forest canopy arcs & floating golden spores
    motifSvg: `
      <path d="M 380 360 C 410 200, 490 120, 620 70 L 640 360 Z" fill="#16a34a" fill-opacity="0.28" />
      <circle cx="465" cy="110" r="14" fill="#bef264" fill-opacity="0.32" />
      <circle cx="540" cy="150" r="22" fill="#4ade80" fill-opacity="0.25" />
      <circle cx="505" cy="75" r="9" fill="#fef08a" fill-opacity="0.42" />
    `
  }
};

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hslToHex(h: number, s: number, l: number): string {
  const normL = l / 100;
  const a = (s * Math.min(normL, 1 - normL)) / 100;
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const color = normL - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Deterministically derives a unique palette & geometric SVG motif from any media item's slug + title
 * so that no two SMB movies, M3U channels, or custom streams ever share the same background artwork.
 */
function buildDeterministicTheme(slug: string, customItem: CatalogItem | null): BuiltInPosterTheme {
  const seedInput = customItem
    ? `${slug}|${customItem.id}|${customItem.title}|${customItem.streamUrl}`
    : slug;
  const hash = crypto.createHash('sha256').update(seedInput).digest();

  const b0 = hash[0] ?? 10;
  const b1 = hash[1] ?? 80;
  const b2 = hash[2] ?? 160;
  const b3 = hash[3] ?? 45;
  const b4 = hash[4] ?? 90;
  const b5 = hash[5] ?? 120;

  const hue1 = (b0 * 360) >> 8;
  const hue2 = (hue1 + 45 + (b1 % 95)) % 360;
  const hueAccent = (hue1 + 150 + (b2 % 60)) % 360;

  const primaryColor = hslToHex(hue1, 68, 26);
  const secondaryColor = hslToHex(hue2, 62, 16);
  const accentColor = hslToHex(hueAccent, 82, 62);

  const cx = 440 + (b3 % 140);
  const cy = 75 + (b4 % 110);
  const r1 = 55 + (b5 % 65);
  const angle = (b2 % 70) - 35;
  const patternType = b0 % 4;

  let motifSvg = '';
  if (patternType === 0) {
    // Rotated geometric prism + satellite orb
    motifSvg = `
      <rect x="${cx - r1}" y="${cy - r1}" width="${r1 * 2}" height="${r1 * 2}" rx="20" transform="rotate(${angle} ${cx} ${cy})" fill="${accentColor}" fill-opacity="0.18" stroke="${accentColor}" stroke-opacity="0.38" stroke-width="2.5" />
      <circle cx="${cx - 45}" cy="${cy + 35}" r="${Math.round(r1 * 0.55)}" fill="${accentColor}" fill-opacity="0.22" />
    `;
  } else if (patternType === 1) {
    // Concentric orbital rings + diagonal beam
    motifSvg = `
      <circle cx="${cx}" cy="${cy}" r="${r1 + 24}" fill="none" stroke="${accentColor}" stroke-opacity="0.32" stroke-width="3" stroke-dasharray="14 8" />
      <circle cx="${cx}" cy="${cy}" r="${r1 - 12}" fill="${accentColor}" fill-opacity="0.19" />
      <line x1="${cx - 110}" y1="${cy - 45}" x2="${cx + 110}" y2="${cy + 45}" stroke="${accentColor}" stroke-opacity="0.28" stroke-width="2" />
    `;
  } else if (patternType === 2) {
    // Layered mountain / wave silhouette + glowing moon
    const peakX = 360 + (b3 % 180);
    const peakY = 80 + (b4 % 70);
    motifSvg = `
      <polygon points="290,360 ${peakX},${peakY} 640,360" fill="${accentColor}" fill-opacity="0.21" />
      <circle cx="${cx}" cy="${cy}" r="${Math.round(r1 * 0.65)}" fill="${accentColor}" fill-opacity="0.28" />
    `;
  } else {
    // Constellation nodes & connecting vectors
    const x2 = cx - 75;
    const y2 = cy + 55;
    const x3 = cx + 55;
    const y3 = cy + 70;
    motifSvg = `
      <polyline points="${cx},${cy} ${x2},${y2} ${x3},${y3} ${cx},${cy}" fill="${accentColor}" fill-opacity="0.16" stroke="${accentColor}" stroke-opacity="0.42" stroke-width="2" />
      <circle cx="${cx}" cy="${cy}" r="9" fill="${accentColor}" fill-opacity="0.65" />
      <circle cx="${x2}" cy="${y2}" r="7" fill="${accentColor}" fill-opacity="0.55" />
      <circle cx="${x3}" cy="${y3}" r="8" fill="${accentColor}" fill-opacity="0.6" />
    `;
  }

  const title = customItem ? customItem.title : `Stream ${slug}`;
  const badge = customItem
    ? `${customItem.resolution || 'HD'} • ${customItem.videoCodec || 'DIRECT'}`
    : 'Open WebTV • Direct Play';

  return {
    primaryColor,
    secondaryColor,
    accentColor,
    title,
    badge,
    motifSvg
  };
}

export function renderPosterSvg(slug: string, customItem: CatalogItem | null = null): string {
  const cleanKey = String(slug || '').replace(/\.svg$/i, '');
  const theme = BUILTIN_THEMES[cleanKey] ?? buildDeterministicTheme(cleanKey, customItem);

  const safeTitle = escapeXml(customItem ? customItem.title : theme.title);
  const safeBadge = escapeXml(
    customItem
      ? `${customItem.resolution || 'HD'} • ${customItem.videoCodec || 'STREAM'}`
      : theme.badge
  );
  const gradId = 'pg-' + cleanKey.replace(/[^a-zA-Z0-9_-]/g, '');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
  <defs>
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme.primaryColor}" />
      <stop offset="58%" stop-color="${theme.secondaryColor}" />
      <stop offset="100%" stop-color="#070b14" />
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#${gradId})" rx="16" />
  ${theme.motifSvg}
  <rect x="36" y="34" width="210" height="34" rx="8" fill="${theme.accentColor}" fill-opacity="0.22" stroke="${theme.accentColor}" stroke-opacity="0.45" stroke-width="1" />
  <text x="141" y="56" fill="#f8fafc" font-family="sans-serif" font-size="13" font-weight="bold" text-anchor="middle">${safeBadge}</text>
  <text x="36" y="268" fill="#ffffff" font-family="sans-serif" font-size="32" font-weight="bold">${safeTitle}</text>
  <text x="36" y="306" fill="#cbd5e1" font-family="sans-serif" font-size="16">Open WebTV • Direct Stream Ready</text>
</svg>`;
}

export function renderBackdropSvg(slug: string, customItem: CatalogItem | null = null): string {
  const cleanKey = String(slug || '').replace(/\.svg$/i, '');
  const theme = BUILTIN_THEMES[cleanKey] ?? buildDeterministicTheme(cleanKey, customItem);
  const gradId = 'bg-' + cleanKey.replace(/[^a-zA-Z0-9_-]/g, '');
  const glowId = 'glow-' + cleanKey.replace(/[^a-zA-Z0-9_-]/g, '');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${theme.primaryColor}" />
      <stop offset="50%" stop-color="${theme.secondaryColor}" />
      <stop offset="100%" stop-color="#040711" />
    </linearGradient>
    <radialGradient id="${glowId}" cx="75%" cy="28%" r="50%">
      <stop offset="0%" stop-color="${theme.accentColor}" stop-opacity="0.28" />
      <stop offset="100%" stop-color="#040711" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#${gradId})" />
  <rect width="1280" height="720" fill="url(#${glowId})" />
  <g transform="scale(2)">
    ${theme.motifSvg}
  </g>
</svg>`;
}
