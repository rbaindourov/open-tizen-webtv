/**
 * Open WebTV - Strict TypeScript Domain Models for Media Server, SMB Catalog & Player
 */

import type { SmartHubPreviewPayload } from '../src/types/tizen.ts';

export type MediaCategory = 'smb' | 'm3u' | 'open';
export type MediaSourceType = 'file' | 'm3u' | 'remote';
export type SubtitleFormat = 'vtt' | 'srt';

export interface ParsedFilenameMetadata {
  readonly title: string;
  readonly year: number | null;
  readonly episodeTag: string | null;
  readonly resolution: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly isHdr: boolean;
  readonly container: string;
  readonly mimeType: string;
  readonly prefersAvPlay: boolean;
}

export interface SidecarNfoMetadata {
  readonly title: string | null;
  readonly year: number | null;
  readonly plot: string | null;
  readonly rating: string | null;
}

export interface WatchProgressEntry {
  readonly itemId: string;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly percent: number;
  readonly updatedAt?: string;
  readonly completed?: boolean;
}

export interface MediaDirectoryEntry {
  readonly id: string;
  readonly path: string;
  readonly label: string;
}

export interface CatalogItem {
  readonly id: string;
  readonly title: string;
  readonly year?: number | null;
  readonly episodeTag?: string | null;
  readonly subtitle: string;
  readonly description: string;
  readonly category: MediaCategory;
  readonly sourceType: MediaSourceType;
  readonly filePath?: string;
  readonly fileSize?: number;
  readonly mimeType?: string;
  readonly container?: string;
  readonly resolution: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly isHdr?: boolean;
  readonly prefersAvPlay: boolean;
  readonly hasSubtitles?: boolean;
  readonly subtitlePath?: string | null;
  readonly subtitleFormat?: SubtitleFormat | null;
  readonly streamUrl: string;
  readonly subtitleUrl?: string | null;
  readonly posterFilePath?: string | null;
  readonly backdropFilePath?: string | null;
  readonly image_ratio: '16by9' | '4by3' | '1by1' | '2by3';
  readonly image_url: string;
  readonly backdrop_url: string;
  readonly action_data: string;
  readonly is_playable: boolean;
  readonly progress?: WatchProgressEntry | null;
  readonly isFavorite?: boolean;
}

export interface CustomStreamInput {
  readonly title: string;
  readonly streamUrl: string;
  readonly year?: number | null;
  readonly subtitle?: string;
  readonly description?: string;
  readonly category?: MediaCategory;
  readonly subtitleUrl?: string | null;
  readonly resolution?: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly prefersAvPlay?: boolean;
  readonly image_url?: string;
  readonly backdrop_url?: string;
}

export interface ScanDirectoryOptions {
  readonly maxDepth?: number;
  readonly label?: string;
}

export interface MediaCatalogManagerOptions {
  readonly initialMediaDir?: string | null;
  readonly initialMediaLabel?: string;
}

export interface MediaCatalogManager {
  readonly mediaDirs: MediaDirectoryEntry[];
  addMediaDirectory(dirPath: string, label?: string): MediaDirectoryEntry;
  addM3uContent(m3uText: string, label?: string): CatalogItem[];
  addCustomStream(streamInfo: CustomStreamInput): CatalogItem;
  updateWatchProgress(
    itemId: string,
    positionSec: number,
    durationSec: number
  ): WatchProgressEntry | null;
  toggleFavorite(itemId: string): boolean;
  getAllItems(baseOrigin?: string): CatalogItem[];
  getItemById(itemId: string, baseOrigin?: string): CatalogItem | null;
  buildSmartHubPreview(baseOrigin?: string): SmartHubPreviewPayload;
}

export interface TelemetryLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly level: string;
  readonly source: string;
  readonly message: string;
  readonly data: unknown;
}

export interface TelemetryLogInput {
  readonly level?: string;
  readonly source?: string;
  readonly message?: string;
  readonly data?: unknown;
}

export interface DevServerOptions {
  readonly silent?: boolean;
  readonly mediaDir?: string | null;
  readonly mediaLabel?: string;
}
