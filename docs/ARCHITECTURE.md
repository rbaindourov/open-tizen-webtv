# Open WebTV Architecture Overview

## 1. End-to-End Media & Tizen IPC Architecture

```mermaid
sequenceDiagram
    participant NAS as SMB Share / Local Disk / M3U
    participant Server as Open WebTV Media Server (Port 4000)
    participant App as Tizen Foreground UI (index.html + app.js)
    participant Player as Hybrid Player (AVPlay + HTML5 Video)
    participant BG as Tizen Background Service (service.js)

    NAS->>Server: Recursive Scan (.mp4, .mkv, .srt, .nfo, .m3u8)
    App->>Server: GET /manifest.json -> Injects styles.css, core.js, player.js, app.js
    App->>Server: GET /api/catalog -> Loads Movies, Codecs, Subtitles & Resume State
    App->>BG: launchAppControl("OSWebTVApp.service")
    BG->>App: MessagePort ("WEBTV_CLIENT_CHANNEL") -> { key: "SERVICE_ONLINE", value: true }
    App->>BG: MessagePort ("WEBTV_SERVICE_CHANNEL") -> { key: "SYNC_PREVIEW_FEED", value: ".../preview.json" }
    BG->>Server: GET /preview.json (Continue Watching + SMB Library + Open Streams)
    BG->>BG: webapis.preview.setPreviewData(JSON) & exit()
    App->>Player: User selects movie (or clicks Smart Hub Preview tile)
    Player->>Server: GET /stream/:id (Range: bytes=...) -> HTTP 206 Partial Content
    Player->>Server: GET /subtitles/:id.vtt (On-the-fly .srt -> .vtt conversion)
    Player->>Server: POST /api/progress ({ itemId, positionSec, durationSec })
```

---

## 2. Module Responsibilities

| Module | File Path | Responsibility |
| :--- | :--- | :--- |
| **Tizen Widget Manifest** | [`src/config.xml`](../src/config.xml) | Declares `OSWebTVApp.OpenWebTV`, `OSWebTVApp.service`, `bg_service` preview metadata, and TV privileges |
| **Dynamic Bundle Loader** | [`src/manifest-loader.js`](../src/manifest-loader.js) | Fetches `/manifest.json` with exponential backoff retries and injects `styles.css`, `core.js`, `player.js`, and `app.js` |
| **Foreground IPC & Key Bridge** | [`src/app-ipc-bridge.js`](../src/app-ipc-bridge.js) | Registers TV remote media keys and manages `WEBTV_CLIENT_CHANNEL` ↔ `WEBTV_SERVICE_CHANNEL` MessagePorts |
| **Smart Hub Preview Service** | [`src/service/service.js`](../src/service/service.js) | Fetches `/preview.json`, validates the schema, updates `webapis.preview.setPreviewData`, and exits cleanly |
| **SMB & Media Catalog Engine** | [`dev-server/media-catalog.js`](../dev-server/media-catalog.js) | Scans mounted SMB/local directories, parses release filenames/codecs, converts `.srt` → `.vtt`, and tracks resume progress |
| **Hybrid Video Player** | [`dev-server/public/player.js`](../dev-server/public/player.js) | Provides unified playback across Samsung hardware `webapis.avplay` and HTML5 `<video>` |
| **10-Foot Media Center UI** | [`dev-server/public/app.js`](../dev-server/public/app.js) | D-Pad navigable media library, OSD video player controls, category filtering, and live SMB/M3U source mounting |
