/**
 * Open WebTV - Strictly Typed SMB / Local Media Scanner, Metadata Parser, M3U & Subtitle Engine
 *
 * Provides:
 * 1. Recursive directory scanner for mounted SMB/CIFS shares or local folders (`.mp4`, `.mkv`, `.webm`, `.ts`, `.m4v`, `.avi`, `.m3u8`).
 * 2. Smart filename metadata parser (Title, Year, Resolution `4K`/`1080p`/`720p`, Codec `HEVC`/`H.264`/`AV1`, Audio `EAC3`/`Atmos`/`DTS`/`AAC`).
 * 3. Sidecar `.nfo` XML metadata parser (Kodi / Jellyfin / Plex compatible) & sidecar poster/backdrop artwork detector.
 * 4. Sidecar `.srt` to `.vtt` (WebVTT) subtitle converter so HTML5 `<track>` can render `.srt` subtitles natively.
 * 5. `#EXTM3U` playlist parser for IPTV and network stream lists with unique per-channel artwork.
 * 6. Persistent in-memory watch progress (`Continue Watching`) & favorites state that dynamically populates
 *    Samsung Smart Hub Preview (`bg_service`) tiles with deep-link resume timestamps (`watch/<id>?t=<sec>`).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  SmartHubPreviewPayload,
  SmartHubPreviewSection
} from '../src/types/tizen.ts';
import type {
  CatalogItem,
  CustomStreamInput,
  MediaCatalogManager,
  MediaCatalogManagerOptions,
  MediaDirectoryEntry,
  ParsedFilenameMetadata,
  ScanDirectoryOptions,
  SidecarNfoMetadata,
  SubtitleFormat,
  WatchProgressEntry
} from './types.ts';

export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.m4v',
  '.mov',
  '.ts',
  '.avi',
  '.m3u8'
]);

export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
  '.m3u8': 'application/vnd.apple.mpegurl'
};

/**
 * Parses scene/release filenames like:
 * - `Dune.Part.Two.2024.2160p.UHD.BluRay.x265.10bit.HDR.EAC3.5.1.mkv`
 * - `The_Matrix_1999_1080p_BluRay_H264_AAC.mp4`
 * - `Severance.S01E04.1080p.WEBRip.HEVC.mkv`
 * into structured movie/episode metadata.
 */
export function parseMediaFilename(filename: string): ParsedFilenameMetadata {
  const ext = path.extname(filename);
  const rawBase = path.basename(filename, ext);
  const normalized = rawBase.replace(/[._]+/g, ' ').trim();

  let resolution = 'HD';
  if (/\b(2160p|4k|uhd)\b/i.test(normalized)) {
    resolution = '4K UHD';
  } else if (/\b1080p\b/i.test(normalized)) {
    resolution = '1080p';
  } else if (/\b720p\b/i.test(normalized)) {
    resolution = '720p';
  } else if (/\b480p\b/i.test(normalized)) {
    resolution = '480p';
  }

  let videoCodec = ext.toLowerCase() === '.mkv' ? 'MKV' : 'H.264';
  if (/\b(x265|h265|hevc)\b/i.test(normalized)) {
    videoCodec = 'HEVC';
  } else if (/\b(x264|h264|avc)\b/i.test(normalized)) {
    videoCodec = 'H.264';
  } else if (/\b(av1)\b/i.test(normalized)) {
    videoCodec = 'AV1';
  }

  const isHdr = /\b(hdr|hdr10|dv|dolby\s*vision)\b/i.test(normalized);

  let audioCodec = 'Stereo';
  if (/\b(atmos|truehd)\b/i.test(normalized)) {
    audioCodec = 'Dolby Atmos';
  } else if (/\b(eac3|ddp|dd\+|\bdd5\s*1)\b/i.test(normalized)) {
    audioCodec = 'EAC3 5.1';
  } else if (/\b(ac3|dd)\b/i.test(normalized)) {
    audioCodec = 'AC3';
  } else if (/\b(dts)\b/i.test(normalized)) {
    audioCodec = 'DTS';
  } else if (/\b(aac)\b/i.test(normalized)) {
    audioCodec = 'AAC';
  }

  const episodeMatch = normalized.match(/\bS(\d{1,2})E(\d{1,2})\b/i);
  const sNum = episodeMatch?.[1];
  const eNum = episodeMatch?.[2];
  const episodeTag =
    sNum && eNum ? `S${sNum.padStart(2, '0')}E${eNum.padStart(2, '0')}` : null;

  const beforeQuality = normalized
    .replace(
      /\b(2160p|1080p|720p|480p|4k|uhd|bluray|brrip|webrip|web[-\s]?dl|hdtv|remux|x264|x265|h264|h265|hevc|10bit|hdr|hdr10|dv|aac|ac3|eac3|dts|proper|repack)\b.*$/i,
      ''
    )
    .trim();

  let year: number | null = null;
  let titlePart = beforeQuality;

  if (episodeMatch && typeof episodeMatch.index === 'number') {
    titlePart = normalized.slice(0, episodeMatch.index).trim();
  }

  const yearMatch = titlePart.match(/^(.*)\s+[\(\[]?((?:19|20)\d{2})[\)\]]?$/);
  const rawTitlePrefix = yearMatch?.[1]?.trim();
  const rawYearStr = yearMatch?.[2];
  if (rawTitlePrefix && rawTitlePrefix.length > 0 && rawYearStr) {
    titlePart = rawTitlePrefix;
    year = Number(rawYearStr);
  }

  const cleanTitle = (titlePart || rawBase)
    .replace(/\s+/g, ' ')
    .replace(/[-–—]+$/, '')
    .trim();

  const prefersAvPlay =
    ['.mkv', '.avi', '.ts'].includes(ext.toLowerCase()) ||
    videoCodec === 'HEVC' ||
    ['AC3', 'EAC3 5.1', 'DTS', 'Dolby Atmos'].includes(audioCodec);

  return {
    title: cleanTitle || rawBase,
    year,
    episodeTag,
    resolution,
    videoCodec,
    audioCodec,
    isHdr,
    container: ext.replace('.', '').toUpperCase(),
    mimeType: MIME_BY_EXT[ext.toLowerCase()] ?? 'video/mp4',
    prefersAvPlay
  };
}

/**
 * Parses an optional Kodi/Jellyfin `.nfo` XML file if present alongside a movie.
 */
export function parseSidecarNfo(nfoPath: string): SidecarNfoMetadata | null {
  try {
    const xml = fs.readFileSync(nfoPath, 'utf8');
    const extractTag = (tag: string): string | null => {
      const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m?.[1] ? m[1].trim() : null;
    };
    const yearStr = extractTag('year');
    return {
      title: extractTag('title'),
      year: yearStr ? Number(yearStr) : null,
      plot: extractTag('plot') ?? extractTag('outline'),
      rating: extractTag('rating')
    };
  } catch (_err: unknown) {
    return null;
  }
}

/**
 * Converts SubRip (`.srt`) subtitle text to WebVTT (`.vtt`) format.
 */
export function convertSrtToVtt(srtContent: string): string {
  const normalized = String(srtContent || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  const body = normalized.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4'
  );

  return 'WEBVTT\n\n' + body + '\n';
}

/**
 * Parses an `#EXTM3U` playlist string into catalog items, assigning each item
 * a unique deterministic poster and stage backdrop SVG if no custom `tvg-logo` is present.
 */
export function parseM3uPlaylist(m3uContent: string, sourceLabel?: string): CatalogItem[] {
  const lines = String(m3uContent || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const items: CatalogItem[] = [];
  let pendingInfo: { title: string; logo: string | null; group: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const titleMatch = line.match(/,(.*)$/);
      const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
      const groupMatch = line.match(/group-title="([^"]+)"/i);
      pendingInfo = {
        title: titleMatch?.[1] ? titleMatch[1].trim() : 'Stream Channel',
        logo: logoMatch?.[1] ?? null,
        group: groupMatch?.[1] ?? (sourceLabel || 'M3U Playlist')
      };
    } else if (!line.startsWith('#')) {
      const info = pendingInfo ?? {
        title: path.basename(line),
        logo: null,
        group: sourceLabel || 'M3U Playlist'
      };
      const id =
        'm3u-' +
        crypto
          .createHash('sha1')
          .update(line + ':' + info.title)
          .digest('hex')
          .slice(0, 12);

      const parsedMeta = parseMediaFilename(info.title);
      items.push({
        id,
        title: info.title,
        subtitle: `${info.group} • Live / Network Stream`,
        description: `Network stream from ${info.group}`,
        category: 'm3u',
        sourceType: 'm3u',
        streamUrl: line,
        image_ratio: '16by9',
        image_url: info.logo ?? `/assets/posters/media-${id}.svg`,
        backdrop_url: `/assets/backgrounds/media-${id}.svg`,
        action_data: `watch/${id}`,
        is_playable: true,
        resolution: parsedMeta.resolution,
        videoCodec: line.endsWith('.m3u8') ? 'HLS' : parsedMeta.videoCodec,
        audioCodec: parsedMeta.audioCodec,
        prefersAvPlay: line.endsWith('.mkv') || line.endsWith('.ts')
      });
      pendingInfo = null;
    }
  }

  return items;
}

function findFirstExistingFile(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Scans a local or SMB-mounted directory recursively (up to maxDepth) for video files,
 * sidecar subtitles (`.srt`/`.vtt`), sidecar `.nfo` metadata, and sidecar poster/backdrop images.
 */
export function scanMediaDirectory(
  rootDir: string,
  options?: ScanDirectoryOptions
): CatalogItem[] {
  const opts: ScanDirectoryOptions = options ?? {};
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 4;
  const sourceLabel = opts.label || path.basename(rootDir) || 'SMB / Local Share';
  const discovered: CatalogItem[] = [];

  if (!rootDir || !fs.existsSync(rootDir)) {
    return discovered;
  }

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (_err: unknown) {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!VIDEO_EXTENSIONS.has(ext)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch (_err: unknown) {
          continue;
        }

        const id =
          'file-' +
          crypto
            .createHash('sha1')
            .update(fullPath)
            .digest('hex')
            .slice(0, 12);

        const baseNoExt = path.join(currentDir, path.basename(entry.name, ext));
        const meta = parseMediaFilename(entry.name);

        const nfoCandidate = findFirstExistingFile([
          baseNoExt + '.nfo',
          path.join(currentDir, 'movie.nfo')
        ]);
        const nfo = nfoCandidate ? parseSidecarNfo(nfoCandidate) : null;

        let subtitlePath: string | null = null;
        let subtitleFormat: SubtitleFormat | null = null;
        if (fs.existsSync(baseNoExt + '.vtt')) {
          subtitlePath = baseNoExt + '.vtt';
          subtitleFormat = 'vtt';
        } else if (fs.existsSync(baseNoExt + '.en.vtt')) {
          subtitlePath = baseNoExt + '.en.vtt';
          subtitleFormat = 'vtt';
        } else if (fs.existsSync(baseNoExt + '.srt')) {
          subtitlePath = baseNoExt + '.srt';
          subtitleFormat = 'srt';
        } else if (fs.existsSync(baseNoExt + '.en.srt')) {
          subtitlePath = baseNoExt + '.en.srt';
          subtitleFormat = 'srt';
        }

        // Detect optional sidecar poster & backdrop/fanart images in SMB folder
        const posterFilePath = findFirstExistingFile([
          baseNoExt + '-poster.jpg',
          baseNoExt + '-poster.png',
          baseNoExt + '.jpg',
          baseNoExt + '.png',
          path.join(currentDir, 'poster.jpg'),
          path.join(currentDir, 'poster.png')
        ]);
        const backdropFilePath = findFirstExistingFile([
          baseNoExt + '-fanart.jpg',
          baseNoExt + '-fanart.png',
          baseNoExt + '-backdrop.jpg',
          baseNoExt + '-background.jpg',
          path.join(currentDir, 'fanart.jpg'),
          path.join(currentDir, 'backdrop.jpg'),
          path.join(currentDir, 'background.jpg'),
          path.join(currentDir, 'background.png')
        ]);

        const title = (nfo && nfo.title) || meta.title;
        const year = (nfo && nfo.year) || meta.year;
        const badgeParts = [
          year ? String(year) : null,
          meta.episodeTag,
          meta.resolution,
          meta.videoCodec,
          meta.audioCodec
        ].filter((part): part is string => Boolean(part));

        discovered.push({
          id,
          title,
          year,
          episodeTag: meta.episodeTag,
          subtitle: `${sourceLabel} • ${badgeParts.join(' • ')}`,
          description:
            (nfo && nfo.plot) ||
            `Streaming from ${sourceLabel} (${path.relative(rootDir, fullPath)})`,
          category: 'smb',
          sourceType: 'file',
          filePath: fullPath,
          fileSize: stat.size,
          mimeType: meta.mimeType,
          container: meta.container,
          resolution: meta.resolution,
          videoCodec: meta.videoCodec,
          audioCodec: meta.audioCodec,
          isHdr: meta.isHdr,
          prefersAvPlay: meta.prefersAvPlay,
          hasSubtitles: Boolean(subtitlePath),
          subtitlePath,
          subtitleFormat,
          streamUrl: `/stream/${id}`,
          subtitleUrl: subtitlePath ? `/subtitles/${id}.vtt` : null,
          posterFilePath,
          backdropFilePath,
          image_ratio: '16by9',
          image_url: posterFilePath
            ? `/artwork/${id}/poster`
            : `/assets/posters/media-${id}.svg`,
          backdrop_url: backdropFilePath
            ? `/artwork/${id}/backdrop`
            : `/assets/backgrounds/media-${id}.svg`,
          action_data: `watch/${id}`,
          is_playable: true
        });
      }
    }
  }

  walk(rootDir, 0);
  return discovered;
}

/**
 * Built-in open-source demo streams (Creative Commons Blender Foundation movies via public test MP4/HLS)
 * Each open movie has its own distinct poster SVG and widescreen backdrop SVG.
 */
export function getBuiltInOpenStreams(): CatalogItem[] {
  return [
    {
      id: 'open-big-buck-bunny',
      title: 'Big Buck Bunny',
      year: 2008,
      subtitle: 'Blender Foundation • 1080p H.264 • Open Movie',
      description:
        'A large and lovable rabbit deals with three tiny bullies in this flagship Blender Foundation open movie.',
      category: 'open',
      sourceType: 'remote',
      streamUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      mimeType: 'video/mp4',
      container: 'MP4',
      resolution: '1080p',
      videoCodec: 'H.264',
      audioCodec: 'AAC',
      prefersAvPlay: false,
      hasSubtitles: true,
      subtitleUrl: '/subtitles/demo.vtt',
      image_ratio: '16by9',
      image_url: '/assets/posters/big-buck-bunny.svg',
      backdrop_url: '/assets/backgrounds/big-buck-bunny.svg',
      action_data: 'watch/open-big-buck-bunny',
      is_playable: true
    },
    {
      id: 'open-sintel',
      title: 'Sintel',
      year: 2010,
      subtitle: 'Blender Foundation • 1080p H.264 • Fantasy Short',
      description:
        'A lonely young woman, Sintel, helps and befriends a dragon, whom she calls Scales.',
      category: 'open',
      sourceType: 'remote',
      streamUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
      mimeType: 'video/mp4',
      container: 'MP4',
      resolution: '1080p',
      videoCodec: 'H.264',
      audioCodec: 'AAC',
      prefersAvPlay: false,
      hasSubtitles: true,
      subtitleUrl: '/subtitles/demo.vtt',
      image_ratio: '16by9',
      image_url: '/assets/posters/sintel.svg',
      backdrop_url: '/assets/backgrounds/sintel.svg',
      action_data: 'watch/open-sintel',
      is_playable: true
    },
    {
      id: 'open-tears-of-steel',
      title: 'Tears of Steel',
      year: 2012,
      subtitle: 'Blender Open Project • 1080p H.264 • Sci-Fi',
      description:
        'In a futuristic Amsterdam, a group of soldiers and scientists gather at the Oude Kerk to stage a crucial event from the past.',
      category: 'open',
      sourceType: 'remote',
      streamUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
      mimeType: 'video/mp4',
      container: 'MP4',
      resolution: '1080p',
      videoCodec: 'H.264',
      audioCodec: 'AAC',
      prefersAvPlay: false,
      hasSubtitles: true,
      subtitleUrl: '/subtitles/demo.vtt',
      image_ratio: '16by9',
      image_url: '/assets/posters/tears-of-steel.svg',
      backdrop_url: '/assets/backgrounds/tears-of-steel.svg',
      action_data: 'watch/open-tears-of-steel',
      is_playable: true
    },
    {
      id: 'open-elephants-dream',
      title: 'Elephants Dream',
      year: 2006,
      subtitle: 'Blender Institute • 1080p H.264 • Surreal Sci-Fi',
      description:
        'Proog and Emo explore the infinite, shifting rooms of a mysterious giant Machine.',
      category: 'open',
      sourceType: 'remote',
      streamUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      mimeType: 'video/mp4',
      container: 'MP4',
      resolution: '1080p',
      videoCodec: 'H.264',
      audioCodec: 'AAC',
      prefersAvPlay: false,
      hasSubtitles: true,
      subtitleUrl: '/subtitles/demo.vtt',
      image_ratio: '16by9',
      image_url: '/assets/posters/elephants-dream.svg',
      backdrop_url: '/assets/backgrounds/elephants-dream.svg',
      action_data: 'watch/open-elephants-dream',
      is_playable: true
    }
  ];
}

export function createMediaCatalogManager(
  options?: MediaCatalogManagerOptions
): MediaCatalogManager {
  const opts: MediaCatalogManagerOptions = options ?? {};
  const mediaDirs: MediaDirectoryEntry[] = [];
  const customStreams: CatalogItem[] = [];
  const m3uSources: CatalogItem[] = [];
  const progressMap: Record<string, WatchProgressEntry> = {};
  const favoritesSet = new Set<string>();

  if (opts.initialMediaDir && fs.existsSync(opts.initialMediaDir)) {
    mediaDirs.push({
      id: 'dir-default',
      path: path.resolve(opts.initialMediaDir),
      label: opts.initialMediaLabel || 'Mounted SMB / Media Share'
    });
  }

  function addMediaDirectory(dirPath: string, label?: string): MediaDirectoryEntry {
    if (!dirPath || typeof dirPath !== 'string') {
      throw new Error('Directory path is required');
    }
    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }
    const existing = mediaDirs.find((d) => d.path === resolved);
    if (existing) {
      return existing;
    }
    const entry: MediaDirectoryEntry = {
      id: 'dir-' + crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8),
      path: resolved,
      label: label || path.basename(resolved) || 'SMB Share'
    };
    mediaDirs.push(entry);
    return entry;
  }

  function addM3uContent(m3uText: string, label?: string): CatalogItem[] {
    const items = parseM3uPlaylist(m3uText, label || 'M3U Playlist');
    for (const item of items) {
      const existingIdx = m3uSources.findIndex((existing) => existing.id === item.id);
      if (existingIdx !== -1) {
        m3uSources[existingIdx] = item;
      } else {
        m3uSources.push(item);
      }
    }
    return items;
  }

  function addCustomStream(streamInfo: CustomStreamInput): CatalogItem {
    if (!streamInfo || !streamInfo.title || !streamInfo.streamUrl) {
      throw new Error('Both title and streamUrl are required');
    }
    const id =
      'custom-' +
      crypto
        .createHash('sha1')
        .update(streamInfo.streamUrl + ':' + streamInfo.title)
        .digest('hex')
        .slice(0, 10);
    const meta = parseMediaFilename(streamInfo.title);
    const item: CatalogItem = {
      id,
      title: streamInfo.title,
      year: streamInfo.year ?? meta.year,
      subtitle:
        streamInfo.subtitle || `Custom Stream • ${meta.resolution} • ${meta.videoCodec}`,
      description:
        streamInfo.description || `Direct network stream (${streamInfo.streamUrl})`,
      category: streamInfo.category ?? 'smb',
      sourceType: 'remote',
      streamUrl: streamInfo.streamUrl,
      subtitleUrl: streamInfo.subtitleUrl ?? null,
      hasSubtitles: Boolean(streamInfo.subtitleUrl),
      resolution: streamInfo.resolution || meta.resolution,
      videoCodec: streamInfo.videoCodec || meta.videoCodec,
      audioCodec: streamInfo.audioCodec || meta.audioCodec,
      container: meta.container,
      prefersAvPlay: Boolean(streamInfo.prefersAvPlay || meta.prefersAvPlay),
      image_ratio: '16by9',
      image_url: streamInfo.image_url || `/assets/posters/media-${id}.svg`,
      backdrop_url: streamInfo.backdrop_url || `/assets/backgrounds/media-${id}.svg`,
      action_data: `watch/${id}`,
      is_playable: true
    };
    const existingIdx = customStreams.findIndex((existing) => existing.id === id);
    if (existingIdx !== -1) {
      customStreams[existingIdx] = item;
    } else {
      customStreams.push(item);
    }
    return item;
  }

  function updateWatchProgress(
    itemId: string,
    positionSec: number,
    durationSec: number
  ): WatchProgressEntry | null {
    if (!itemId) return null;
    const pos = Math.max(0, Number(positionSec) || 0);
    const dur = Math.max(0, Number(durationSec) || 0);
    if (dur > 0 && pos / dur >= 0.95) {
      delete progressMap[itemId];
      return {
        itemId,
        completed: true,
        positionSec: 0,
        durationSec: dur,
        percent: 100
      };
    }
    const entry: WatchProgressEntry = {
      itemId,
      positionSec: Math.round(pos),
      durationSec: Math.round(dur),
      percent: dur > 0 ? Math.min(99, Math.round((pos / dur) * 100)) : 0,
      updatedAt: new Date().toISOString()
    };
    progressMap[itemId] = entry;
    return entry;
  }

  function toggleFavorite(itemId: string): boolean {
    if (!itemId) return false;
    if (favoritesSet.has(itemId)) {
      favoritesSet.delete(itemId);
      return false;
    }
    favoritesSet.add(itemId);
    return true;
  }

  function getAllItems(baseOrigin?: string): CatalogItem[] {
    const origin = (baseOrigin || '').replace(/\/+$/, '');
    const scannedFiles: CatalogItem[] = [];
    for (const dir of mediaDirs) {
      scannedFiles.push(...scanMediaDirectory(dir.path, { label: dir.label }));
    }

    const rawItems: CatalogItem[] = [
      ...scannedFiles,
      ...customStreams,
      ...m3uSources,
      ...getBuiltInOpenStreams()
    ];

    const hydrateUrl = (u: string | null | undefined): string => {
      if (!u) return '';
      if (origin && u.startsWith('/')) return origin + u;
      return u;
    };

    return rawItems.map((item) => {
      const progress = progressMap[item.id] ?? null;
      const isFavorite = favoritesSet.has(item.id);
      return {
        ...item,
        streamUrl: hydrateUrl(item.streamUrl),
        subtitleUrl: item.subtitleUrl ? hydrateUrl(item.subtitleUrl) : null,
        image_url: hydrateUrl(item.image_url),
        backdrop_url: hydrateUrl(item.backdrop_url),
        progress,
        isFavorite
      };
    });
  }

  function getItemById(itemId: string, baseOrigin?: string): CatalogItem | null {
    const all = getAllItems(baseOrigin);
    return all.find((item) => item.id === itemId) ?? null;
  }

  function buildSmartHubPreview(baseOrigin?: string): SmartHubPreviewPayload {
    const items = getAllItems(baseOrigin);
    const sections: SmartHubPreviewSection[] = [];

    const continueWatching = items
      .filter(
        (i): i is CatalogItem & { progress: WatchProgressEntry } =>
          Boolean(i.progress && i.progress.positionSec > 5)
      )
      .sort((a, b) =>
        (b.progress.updatedAt || '').localeCompare(a.progress.updatedAt || '')
      );

    if (continueWatching.length > 0) {
      sections.push({
        title: 'Continue Watching',
        tiles: continueWatching.slice(0, 6).map((item, idx) => ({
          title: `${item.title} (${item.progress.percent}%)`,
          subtitle: item.subtitle,
          image_ratio: '16by9',
          image_url: item.image_url,
          action_data: `watch/${item.id}?t=${item.progress.positionSec}`,
          is_playable: true,
          position: idx
        }))
      });
    }

    const smbMovies = items.filter((i) => i.category === 'smb' || i.category === 'm3u');
    if (smbMovies.length > 0) {
      sections.push({
        title: 'SMB & Media Server Library',
        tiles: smbMovies.slice(0, 8).map((item, idx) => ({
          title: item.title,
          subtitle: item.subtitle,
          image_ratio: '16by9',
          image_url: item.image_url,
          action_data: item.action_data,
          is_playable: true,
          position: idx
        }))
      });
    }

    const openStreams = items.filter((i) => i.category === 'open');
    sections.push({
      title: 'Featured Open Streams',
      tiles: openStreams.slice(0, 6).map((item, idx) => ({
        title: item.title,
        subtitle: item.subtitle,
        image_ratio: '16by9',
        image_url: item.image_url,
        action_data: item.action_data,
        is_playable: true,
        position: idx
      }))
    });

    return { sections };
  }

  return {
    mediaDirs,
    addMediaDirectory,
    addM3uContent,
    addCustomStream,
    updateWatchProgress,
    toggleFavorite,
    getAllItems,
    getItemById,
    buildSmartHubPreview
  };
}
