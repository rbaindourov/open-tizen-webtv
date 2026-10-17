# Open WebTV for Samsung Tizen (`open-tizen-webtv`)

An unbranded, strictly-typed **TypeScript** open-source **Samsung Smart TV (Tizen OS) Media Center**, **Dynamic Manifest Wrapper**, **Smart Hub Launcher Preview Background Service**, and **SMB / LAN Media Streaming Gateway** that compiles down to Tizen 2.4+ through 8.0+ compatible JavaScript.

---

## Core Capabilities

1. **Strictly Typed TypeScript Codebase (`tsconfig.json`, `src/**/*.ts`, `dev-server/**/*.ts`, `scripts/**/*.ts`, `test/**/*.ts`)**:
   - Authored 100% in strict TypeScript (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`, `noUncheckedIndexedAccess: true`) with complete type declarations for Samsung `tizen.*` and `webapis.*` (`src/types/tizen.ts`).
   - Automatically transpiles foreground and background service modules into Tizen 2.4+ ES5-compatible JavaScript (`scripts/transpile-tizen.ts`) for `.wgt` packaging and live browser/TV bundle delivery.
2. **Bespoke Procedural PNG & Unique Vector Asset Engine (`dev-server/assets.ts`)**:
   - Generates a multi-layer RGBA app icon (`src/logo.png`), a 16:9 aurora cinema background (`src/background.png` and `/assets/background.svg`), distinct custom vector scenes for built-in open movies, and deterministic SHA-256 hash-seeded unique color palettes and geometric motifs for every SMB movie, M3U channel, and custom stream (`/assets/posters/*.svg` and `/assets/backgrounds/*.svg`).
3. **SMB Share & Local Media Library Scanner (`dev-server/media-catalog.ts`)**:
   - Point `MEDIA_DIR=/mnt/smb/movies` (or mount folders live from the TV UI via `POST /api/sources/smb`) to recursively index `.mp4`, `.mkv`, `.webm`, `.m4v`, `.mov`, `.avi`, `.ts`, and `.m3u8` files.
   - **Smart Release Filename Parser**: Automatically extracts clean movie titles, release years, `SxxExx` episode tags, resolution badges (`4K UHD`, `1080p`, `720p`), and codec badges (`HEVC`/`x265`, `H.264`, `HDR`, `EAC3 5.1`, `Dolby Atmos`, `DTS`).
   - **Sidecar NFO, Artwork & Subtitle Discovery**: Automatically reads Kodi/Jellyfin `.nfo` XML metadata (`<title>`, `<year>`, `<plot>`), serves sidecar poster/fanart images (`/artwork/:id/poster`, `/artwork/:id/backdrop`), and converts sidecar `.srt` subtitles to WebVTT (`/subtitles/:id.vtt`) on the fly.
4. **RFC 7233 HTTP `206 Partial Content` Byte-Range Video Streamer (`/stream/:id`)**:
   - Streams multi-gigabyte `.mp4` and `.mkv` files over your LAN with instant byte-range seeking (`FastForward` / `Rewind`) on Samsung Tizen TVs.
5. **M3U / IPTV & Custom Stream Ingestion (`/api/sources/m3u`, `/api/sources/stream`)**:
   - Import `#EXTM3U` playlists or direct Jellyfin/Emby/DLNA HTTP stream URLs at runtime.
6. **Hybrid Video Player Engine (`AVPlay` Hardware + `HTML5 <video>`) (`dev-server/public/player.ts`)**:
   - **Samsung Native `webapis.avplay`**: Automatically selected on Tizen TV hardware for `.mkv` containers, `HEVC` (H.265), 4K HDR, and `AC3`/`EAC3`/`DTS` surround audio, with multi-audio track switching.
   - **HTML5 `<video>`**: Supports WebVTT `<track>` subtitles, variable playback speeds (`0.75x`–`2.0x`), aspect ratio modes (`contain`, `cover`, `fill`), and automatic fallback.
7. **Dynamic "Continue Watching" & Smart Hub Preview (`src/service/service.ts`)**:
   - Tracks playback progress (`POST /api/progress`) and dynamically populates a **"Continue Watching"** ribbon right on the Samsung TV home screen launcher (`webapis.preview.setPreviewData`), complete with deep-link resume (`watch/<id>?t=<seconds>`).

---

## Quick Start

```bash
# 1. Run strict TypeScript static type checking
npm run typecheck

# 2. Validate Tizen XML & Service JSON consistency
npm run validate:config

# 3. Run the 10-part automated unit & integration test suite
npm test

# 4. Build an unsigned Tizen widget archive (dist/OpenWebTV.wgt)
npm run build:wgt

# 5. Launch the Media Server & Remote Logger (optionally pointing at your mounted SMB share)
MEDIA_DIR=/mnt/smb/movies npm start
```

Open `http://127.0.0.1:4000/` in your browser or Tizen TV Emulator to browse your library, filter by category (*All*, *Continue Watching*, *Favorites*, *SMB / Local*, *M3U*, *Open Movies*), mount new SMB directories, and play streams with full OSD controls.

---

## API Reference

| Endpoint | Method | Description |
| :--- | :---: | :--- |
| `/manifest.json` | `GET` | Dynamic CSS & JS bundle manifest consumed by `src/manifest-loader.ts` |
| `/preview.json` | `GET` | Dynamic Samsung Smart Hub Preview (`bg_service`) feed (*Continue Watching*, *SMB Library*, *Featured*) |
| `/api/catalog` | `GET` | Full indexed movie & channel catalog with codecs, subtitles, and resume state |
| `/api/sources/smb` | `POST` | Mount and index a local or SMB directory (`{ "path": "/mnt/smb/movies", "label": "NAS" }`) |
| `/api/sources/m3u` | `POST` | Parse and import an `#EXTM3U` playlist (`{ "content": "#EXTM3U...", "label": "IPTV" }`) |
| `/api/sources/stream` | `POST` | Add a custom stream (`{ "title": "Movie", "streamUrl": "http://..." }`) |
| `/api/progress` | `POST` | Save watch progress (`{ "itemId": "...", "positionSec": 120, "durationSec": 3600 }`) |
| `/api/favorites` | `POST` | Toggle favorite star (`{ "itemId": "..." }`) |
| `/stream/:id` | `GET` | HTTP `206 Partial Content` byte-range video stream for local/SMB files |
| `/subtitles/:id.vtt` | `GET` | WebVTT subtitle stream (automatically converts `.srt` sidecars on the fly) |
| `/assets/background.svg` | `GET` | Bespoke 1920x1080 ambient cinema background SVG |
| `/assets/posters/*.svg` | `GET` | Unique per-item vector poster artwork |
| `/assets/backgrounds/*.svg` | `GET` | Unique per-item 16:9 widescreen hero stage backdrop SVG |
| `/artwork/:id/:kind` | `GET` | Local sidecar poster or backdrop image from mounted SMB share |
| `/log` & `/logs` | `GET/POST` | Remote telemetry logger sink & ring-buffer inspector for Tizen debugging |

---

## Documentation

- [Architecture & Modernization Overview](docs/ARCHITECTURE.md)
- [Samsung Smart Hub Preview (`bg_service`) & Deep-Linking Guide](docs/SMART_HUB_PREVIEW.md)

---

## License

Released under the [MIT License](LICENSE).
