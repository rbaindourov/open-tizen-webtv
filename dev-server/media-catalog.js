/**
 * Open WebTV - Multi-Source Media Catalog, SMB/Directory Scanner & Subtitle Engine
 *
 * Capabilities:
 * - Scans local or mounted SMB/NAS directories (`MEDIA_DIR`) recursively for video files
 *   (.mp4, .mkv, .webm, .m4v, .mov, .avi, .ts, .m3u8).
 * - Parses scene/release filenames into clean titles, release years, resolution badges
 *   (4K UHD, 1080p, 720p), video/audio codec tags (HEVC, H.264, HDR, AAC, AC3), and SxxExx tags.
 * - Automatically discovers sidecar subtitles (`.srt`, `.vtt`), poster images, and `.nfo` XML files.
 * - Converts `.srt` subtitles to WebVTT (`.vtt`) on the fly for HTML5 `<track>` compatibility.
 * - Parses `.m3u` / `.m3u8` playlists (`#EXTINF`) into playable catalog items.
 * - Manages persistent watch progress (`Continue Watching`) and user favorites.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.m4v',
  '.mov',
  '.avi',
  '.ts',
  '.m3u8'
]);

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m3u8': 'application/vnd.apple.mpegurl'
};

/**
 * Parses a raw filename (e.g. "Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.10bit.HDR.AC3.mkv")
 * into structured movie/episode metadata.
 */
function parseMediaFilename(filename) {
  const ext = path.extname(filename);
  const rawBase = path.basename(filename, ext);
  const normalized = rawBase.replace(/[._]+/g, ' ').trim();

  // Detect resolution
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

  // Detect video codec
  let videoCodec = ext.toLowerCase() === '.mkv' ? 'MKV' : 'H.264';
  if (/\b(x265|h265|hevc)\b/i.test(normalized)) {
    videoCodec = 'HEVC';
  } else if (/\b(x264|h264|avc)\b/i.test(normalized)) {
    videoCodec = 'H.264';
  } else if (/\b(av1)\b/i.test(normalized)) {
    videoCodec = 'AV1';
  }

  // Detect HDR
  const isHdr = /\b(hdr|hdr10|dv|dolby\s*vision)\b/i.test(normalized);

  // Detect audio codec
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

  // Detect Season/Episode (e.g. S01E04)
  const episodeMatch = normalized.match(/\bS(\d{1,2})E(\d{1,2})\b/i);
  const episodeTag = episodeMatch
    ? `S${episodeMatch[1].padStart(2, '0')}E${episodeMatch[2].padStart(2, '0')}`
    : null;

  // Strip common release noise tokens first so the release year sits at the end of the title segment
  const beforeQuality = normalized
    .replace(
      /\b(2160p|1080p|720p|480p|4k|uhd|bluray|brrip|webrip|web-dl|web|hdtv|remux|x264|x265|h264|h265|hevc|10bit|hdr|hdr10|dv|aac|ac3|eac3|dts|proper|repack)\b.*$/i,
      ''
    )
    .trim();

  // Detect Year (1920..2039) greedily at the end of beforeQuality
  let year = null;
  let titlePart = beforeQuality;

  if (episodeMatch) {
    titlePart = normalized.slice(0, episodeMatch.index).trim();
  }

  const yearMatch = titlePart.match(/^(.*)\s+\(?((?:19|20)\d{2})\)?$/);
  if (yearMatch && yearMatch[1].trim().length > 0) {
    titlePart = yearMatch[1].trim();
    year = Number(yearMatch[2]);
  }

  const cleanTitle = (titlePart || rawBase)
    .replace(/\s+/g, ' ')
    .replace(/[-–—]+$/, '')
    .trim();

  // Recommend AVPlay on Tizen if container is MKV/AVI/TS or codec is HEVC/AC3/DTS
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
    mimeType: MIME_BY_EXT[ext.toLowerCase()] || 'video/mp4',
    prefersAvPlay
  };
}

/**
 * Parses an optional Kodi/Jellyfin `.nfo` XML file if present alongside a movie.
 */
function parseSidecarNfo(nfoPath) {
  try {
    const xml = fs.readFileSync(nfoPath, 'utf8');
    const extractTag = (tag) => {
      const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : null;
    };
    return {
      title: extractTag('title'),
      year: extractTag('year') ? Number(extractTag('year')) : null,
      plot: extractTag('plot') || extractTag('outline'),
      rating: extractTag('rating')
    };
  } catch (err) {
    return null;
  }
}

/**
 * Converts SubRip (`.srt`) subtitle text to WebVTT (`.vtt`) format.
 */
function convertSrtToVtt(srtContent) {
  const normalized = String(srtContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  // Convert comma millisecond separator (00:01:23,456 --> 00:01:25,789) to dot (00:01:23.456)
  const body = normalized.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4'
  );

  return 'WEBVTT\n\n' + body + '\n';
}

/**
 * Parses an `#EXTM3U` playlist string into catalog items.
 */
function parseM3uPlaylist(m3uContent, sourceLabel) {
  const lines = String(m3uContent || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  let pendingInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTINF:')) {
      const titleMatch = line.match(/,(.*)$/);
      const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
      const groupMatch = line.match(/group-title="([^"]+)"/i);
      pendingInfo = {
        title: titleMatch ? titleMatch[1].trim() : 'Stream Channel',
        logo: logoMatch ? logoMatch[1] : null,
        group: groupMatch ? groupMatch[1] : sourceLabel || 'M3U Playlist'
      };
    } else if (!line.startsWith('#')) {
      const info = pendingInfo || {
        title: path.basename(line),
        logo: null,
        group: sourceLabel || 'M3U Playlist'
      };
      const id =
        'm3u-' +
        crypto
          .createHash('sha1')
          .update(line)
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
        image_url: info.logo || '/assets/posters/big-buck-bunny.svg',
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

/**
 * Scans a local or SMB-mounted directory recursively (up to maxDepth) for video files.
 */
function scanMediaDirectory(rootDir, options) {
  const opts = options || {};
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 4;
  const sourceLabel = opts.label || path.basename(rootDir) || 'SMB / Local Share';
  const discovered = [];

  if (!rootDir || !fs.existsSync(rootDir)) {
    return discovered;
  }

  function walk(currentDir, depth) {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
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

        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (err) {
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

        // Check for sidecar NFO
        const nfoCandidate = fs.existsSync(baseNoExt + '.nfo')
          ? baseNoExt + '.nfo'
          : fs.existsSync(path.join(currentDir, 'movie.nfo'))
            ? path.join(currentDir, 'movie.nfo')
            : null;
        const nfo = nfoCandidate ? parseSidecarNfo(nfoCandidate) : null;

        // Check for sidecar Subtitles (.vtt or .srt)
        let subtitlePath = null;
        let subtitleFormat = null;
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

        const title = (nfo && nfo.title) || meta.title;
        const year = (nfo && nfo.year) || meta.year;
        const badgeParts = [
          year ? String(year) : null,
          meta.episodeTag,
          meta.resolution,
          meta.videoCodec,
          meta.audioCodec
        ].filter(Boolean);

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
          image_ratio: '16by9',
          image_url: `/assets/posters/media-${id}.svg`,
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
 */
function getBuiltInOpenStreams() {
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
      streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
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
      streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
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
      streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
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
      streamUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      mimeType: 'video/mp4',
      container: 'MP4',
      resolution: '1080p',
      videoCodec: 'H.264',
      audioCodec: 'AAC',
      prefersAvPlay: false,
      hasSubtitles: true,
      subtitleUrl: '/subtitles/demo.vtt',
      image_ratio: '16by9',
      image_url: '/assets/posters/cosmos-laundromat.svg',
      action_data: 'watch/open-elephants-dream',
      is_playable: true
    }
  ];
}

function createMediaCatalogManager(options) {
  const opts = options || {};
  const mediaDirs = [];
  const customStreams = [];
  const m3uSources = [];
  const progressMap = {}; // id -> { positionSec, durationSec, updatedAt }
  const favoritesSet = new Set();

  if (opts.initialMediaDir && fs.existsSync(opts.initialMediaDir)) {
    mediaDirs.push({
      id: 'dir-default',
      path: path.resolve(opts.initialMediaDir),
      label: opts.initialMediaLabel || 'Mounted SMB / Media Share'
    });
  }

  function addMediaDirectory(dirPath, label) {
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
    const entry = {
      id: 'dir-' + crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8),
      path: resolved,
      label: label || path.basename(resolved) || 'SMB Share'
    };
    mediaDirs.push(entry);
    return entry;
  }

  function addM3uContent(m3uText, label) {
    const items = parseM3uPlaylist(m3uText, label || 'M3U Playlist');
    m3uSources.push(...items);
    return items;
  }

  function addCustomStream(streamInfo) {
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
    const item = {
      id,
      title: streamInfo.title,
      year: streamInfo.year || meta.year,
      subtitle: streamInfo.subtitle || `Custom Stream • ${meta.resolution} • ${meta.videoCodec}`,
      description: streamInfo.description || `Direct network stream (${streamInfo.streamUrl})`,
      category: streamInfo.category || 'smb',
      sourceType: 'remote',
      streamUrl: streamInfo.streamUrl,
      subtitleUrl: streamInfo.subtitleUrl || null,
      hasSubtitles: Boolean(streamInfo.subtitleUrl),
      resolution: streamInfo.resolution || meta.resolution,
      videoCodec: streamInfo.videoCodec || meta.videoCodec,
      audioCodec: streamInfo.audioCodec || meta.audioCodec,
      container: meta.container,
      prefersAvPlay: Boolean(streamInfo.prefersAvPlay || meta.prefersAvPlay),
      image_ratio: '16by9',
      image_url: streamInfo.image_url || `/assets/posters/media-${id}.svg`,
      action_data: `watch/${id}`,
      is_playable: true
    };
    customStreams.push(item);
    return item;
  }

  function updateWatchProgress(itemId, positionSec, durationSec) {
    if (!itemId) return null;
    const pos = Math.max(0, Number(positionSec) || 0);
    const dur = Math.max(0, Number(durationSec) || 0);
    // If watched >= 95%, clear from Continue Watching
    if (dur > 0 && pos / dur >= 0.95) {
      delete progressMap[itemId];
      return { itemId, completed: true, positionSec: 0, durationSec: dur };
    }
    progressMap[itemId] = {
      itemId,
      positionSec: Math.round(pos),
      durationSec: Math.round(dur),
      percent: dur > 0 ? Math.min(99, Math.round((pos / dur) * 100)) : 0,
      updatedAt: new Date().toISOString()
    };
    return progressMap[itemId];
  }

  function toggleFavorite(itemId) {
    if (!itemId) return false;
    if (favoritesSet.has(itemId)) {
      favoritesSet.delete(itemId);
      return false;
    }
    favoritesSet.add(itemId);
    return true;
  }

  function getAllItems(baseOrigin) {
    const origin = (baseOrigin || '').replace(/\/+$/, '');
    const scannedFiles = [];
    for (const dir of mediaDirs) {
      scannedFiles.push(...scanMediaDirectory(dir.path, { label: dir.label }));
    }

    const rawItems = [
      ...scannedFiles,
      ...customStreams,
      ...m3uSources,
      ...getBuiltInOpenStreams()
    ];

    return rawItems.map((item) => {
      const progress = progressMap[item.id] || null;
      const isFavorite = favoritesSet.has(item.id);
      const hydrateUrl = (u) => {
        if (!u) return u;
        if (origin && u.startsWith('/')) return origin + u;
        return u;
      };
      return {
        ...item,
        streamUrl: hydrateUrl(item.streamUrl),
        subtitleUrl: hydrateUrl(item.subtitleUrl),
        image_url: hydrateUrl(item.image_url),
        progress,
        isFavorite
      };
    });
  }

  function getItemById(itemId, baseOrigin) {
    const all = getAllItems(baseOrigin);
    return all.find((item) => item.id === itemId) || null;
  }

  /**
   * Builds the Samsung Smart Hub Preview (`bg_service`) payload dynamically:
   * - Section 1: "Continue Watching" (if user has in-progress movies)
   * - Section 2: "SMB & Local Movies" (if local/SMB shares are mounted)
   * - Section 3: "Featured Open Streams"
   */
  function buildSmartHubPreview(baseOrigin) {
    const items = getAllItems(baseOrigin);
    const sections = [];

    const continueWatching = items
      .filter((i) => i.progress && i.progress.positionSec > 5)
      .sort((a, b) => (b.progress.updatedAt || '').localeCompare(a.progress.updatedAt || ''));

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

module.exports = {
  VIDEO_EXTENSIONS,
  MIME_BY_EXT,
  parseMediaFilename,
  parseSidecarNfo,
  convertSrtToVtt,
  parseM3uPlaylist,
  scanMediaDirectory,
  getBuiltInOpenStreams,
  createMediaCatalogManager
};
