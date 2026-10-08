# Aurora Music

<p align="center">
  <img src="./packages/desktop/resources/icon.svg" alt="Aurora Music icon" width="128">
</p>

<p align="center">
  <strong>Aurora Music</strong> — a cross-platform music player for <strong>desktop (Linux / Windows / macOS) and Android</strong>.<br/>
  The desktop app is Electron + React + Vite; the mobile app is packaged with Capacitor and hands playback to a native engine, so one UI codebase stays consistent across platforms.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="PolyForm Noncommercial License 1.0.0">
  &nbsp;·&nbsp; <a href="./README.md">中文说明</a>
</p>

---

## Screenshots

**Desktop** — library / now playing / settings (online sources)

<p align="center">
  <img src="./screenshots/library.jpg" width="760" alt="Library">
</p>

<table align="center"><tr>
  <td><img src="./screenshots/detail.jpg" width="520" alt="Now playing"></td>
  <td><img src="./screenshots/settings.jpg" width="520" alt="Settings"></td>
</tr></table>

**Android** — native playback engine with lock-screen and notification controls

<p align="center">
  <img src="./screenshots/android-playing.jpg" width="280" alt="Android lock screen playback">
</p>

---

## Features

| Capability | Desktop (Linux / Windows / macOS) | Android |
|---|---|---|
| Local playback | Folder scanning with progressive indexing | System folder import with storage permission flow |
| Background playback | Keeps playing in the tray after the window is closed | MediaSession foreground service; stable on the lock screen and after deep screen-off |
| Online search | Search / preview / download / cache (adjustable quota, one-click clear) | Same quota model; configurable download folder, native background download |
| In-app updates | Per-platform package recommendation (EXE / RPM / DEB / AppImage / DMG), one-click install | Hands off to the system installer |

The first screen is **Library** — recommended playlists and charts served by the music source you configure; the app ships no built-in scraper. **My Music** is your own scanned collection from local folders or WebDAV: long-lived and playable offline. With no source configured, Library shows a guided empty state while the local collection keeps working.

- **Library** — recommended playlists and song charts; play instantly without adding to the library
- **My Music** — favorites, recently played, play counts, quick search, queue management, sequential / shuffle / repeat-one
- **Lyrics** — LRC synchronized lyrics (including word-level timestamps), provided by your music source: configure one source and lyrics come with it
- **Playlist import** — share links (resolved through your source) or plain text (handled locally, zero network requests), matched against your local library
- **WebDAV media library** — mount Synology / QNAP / Nextcloud / rclone folders; scanned tracks persist (desktop)
- **Appearance** — Liquid Glass aesthetics, dynamic cover glow background, dark / light / follow-system themes
- **Resilient update delivery** — update checks and installer downloads fall back from GitHub official to public mirrors: checks race the candidates concurrently, downloads follow the system proxy and switch source when one is clearly slower, mirrors are only the offline fallback

> The application UI is currently Chinese-only. Locale-driven English UI is planned.

---

## Music sources

The app bundles **no** music sources. Online search, lyric matching and playlist resolution all use HTTP endpoints you configure, or LX Music–style user source scripts (Settings → Online sources). **One source provides all three capabilities** — lyrics no longer need a separate configuration.

### Aurora source service

Enter a single service address. Endpoints are read from the service's self-description (`endpoints` in the response of `GET {base}/`) and fall back to the default paths below; the key may be embedded in the link (`https://host?key=xxx`), and "Test connection" verifies reachability and the key.

| Capability | Default endpoint | Response notes |
|---|---|---|
| Search | `/aurora?query={query}&quality={quality}&key=` | A JSON array, or wrapped in `{results:[]}` / `{data:[]}` / `{songs:[]}` / `{list:[]}`; each item requires `audioUrl` and accepts `title` / `artist` / `album` / `duration` / `coverUrl`; multiple qualities use `qualityUrls` or `url_128` / `url_320` / `url_flac` |
| Lyrics | `/aurora/lyric?track={track}&artist={artist}&duration={duration}&key=` | Accepts `syncedLyrics` / `lrc` / `lyric` / `plainLyrics`; falls back to the built-in LRCLIB when no source matches |
| Playlist | `/aurora/playlist?url={url}&key=` | Each item uses `title` / `artist` (also `name` / `songName` / `singer`), with an optional `name` for the playlist title |
| Recommend / charts | `/aurora/recommend`, `/aurora/toplists`, `/aurora/toplist` | Recommended playlists and charts on the Library screen |

A link containing `{query}` is used verbatim as an endpoint template for third-party APIs (this form has no lyrics capability). Request headers are an optional JSON object for auth, Referer or User-Agent. The separate "playlist resolver" and "lyrics source" entries from v0.4.x are merged automatically on upgrade.

### LX Music source scripts

User source scripts written for [LX Music](https://github.com/lyswhut/lx-music-desktop) (desktop or mobile) work as-is: add the script URL (GitHub Raw, jsDelivr or your own host) to the source list. The script source is never written to the database.

Scripts run inside a client-side sandbox: `document` / `navigator` / `location` / `localStorage` and the Node globals (`process` / `require` / `module` / `exports` / `global`) are all `undefined`, script logs are silenced, and network requests can only go through the host's `lx.request`. Scripts get no access to host configuration, the database or the file system — which is also why they work on every platform.

Most scripts only implement `musicUrl` and expose no public search API, so search uses your own search source and the script resolves the audio address from the platform identifiers of a track (Kuwo `kw` / Kugou `kg`: `hash` | `songmid`; QQ `tx` / NetEase `wy`: `songmid`, NetEase also accepts `id`; Migu `mg`: title + artist):

- The few scripts that ship `search` / `musicSearch` take part in search directly; when required fields are missing the app reports a readable reason instead of guessing an id
- Address resolution is on demand: script search results carry metadata only, and the direct URL is fetched when you play or download, then filled into the current queue — never written to the database or to disk
- Script sources provide address resolution only, with no lyrics capability

> Script names above only illustrate protocol differences; the app bundles no sources and recommends none.

### WebDAV library (desktop)

Unlike online sources this is a persistent, indexed library: set the server address, account and password, test the connection, then scan. Credentials stay on the machine; removing a source deletes its tracks from the library (files on the server are untouched).

---

## Getting started

```bash
git clone https://github.com/yib0601/aurora-music.git && cd aurora-music
pnpm install
pnpm rebuild          # rebuild the better-sqlite3 native module
pnpm dev              # desktop app (Electron + Vite HMR)
pnpm dev:app          # web UI only
```

The repository is a pnpm monorepo: `packages/{app, desktop, mobile, shared}`. Requirements: Node.js ≥ 20, pnpm ≥ 9.15; Android builds additionally need JDK 17+ and the Android SDK.

Tests:

```bash
pnpm --filter @aurora/shared test   # source protocol and the LX host (pure logic)
pnpm --filter @aurora/app test      # renderer and mobile cache persistence
```

Four cases in `@aurora/shared` read external fixtures (the third-party LX script repo `pdone/lx-music-source`, not vendored): a local clone is preferred, otherwise it is shallow-cloned into a temp directory, and restricted networks skip the cases. Point at a local clone with `LX_SCRIPT_DIR`, set the cache with `LX_SCRIPT_CACHE`.

Android build:

```bash
pnpm build:app
cd packages/mobile && npx cap sync android
cd android && ./gradlew assembleDebug   # output in app/build/outputs/apk/
```

> Web-layer changes need `build:app` before `cap sync`, otherwise stale assets get packaged; native-only changes just need gradlew again.

Platform notes:

- **Linux** uses the X11 backend (under Wayland this is served by Xwayland). Frameless window resizing at screen edges depends on the client being able to set its own window position, which native Wayland does not allow — dragging the top or left edge degrades to resizing from the bottom or right. Use `--ozone-platform=wayland` to fall back for debugging.
- **macOS** DMGs are split by architecture (`-arm64` / `-x64`). They are ad-hoc signed and not notarized; if Gatekeeper blocks the first launch, run `xattr -cr /Applications/Aurora-Music.app`.
- **Mobile UI preview** — after `pnpm dev:app`, open `http://localhost:5173/?ui=mobile` to force the mobile layout (`?ui=desktop` for the opposite; this only switches the layout branch); `http://localhost:5173/mobile-lab.html?ui=mobile&scene=np` is the now-playing acceptance page (`scene`: `np` / `np-paused` / `np-empty` / `bar` / `bar-empty`, plus `theme=light` and `t=<seconds>`). Preview at both phone and large-screen viewports: a width ≥ 1024 or both dimensions ≥ 520 CSS pixels is the car / tablet shell (persistent sidebar), so phone widths alone miss that case.
- Re-run `pnpm rebuild` after switching Node or Electron versions.

---

## Building and distribution

- **Desktop** — `pnpm build:desktop`; artifacts land in `packages/desktop/release/` (Linux AppImage / deb, Windows NSIS). RPM uses the bundled `./build-rpm.sh`. Linux builds are compiled inside an Ubuntu 22.04 container so the packages keep a glibc 2.35 / libstdc++ 6.0.30 baseline and run on older distributions; `scripts/check-linux-baseline.sh` verifies this before a release is published.
- **Release** — pushing a `v*` tag triggers GitHub Actions to build every platform (Windows / Linux / macOS both architectures / Android) and publish a release, after verifying the APK signature, the macOS artifacts and the Linux glibc baseline.
- **Signing key** — APKs are signed with the keystore committed at `packages/mobile/android/app/aurora-music.keystore` (SHA-256 `eb4e48a95587ed954789b81b20fc23689cc702e602ebac08050d308eabdb435b`), and CI verifies the fingerprint on every run. This file must never be replaced, or existing users lose the ability to upgrade in place.

---

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — commercial use is not permitted. Personal use, study, modification and non-commercial distribution are unrestricted; commercial use requires permission from the author. Versions up to v0.4.2 remain MIT licensed.
