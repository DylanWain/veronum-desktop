# Veronum Desktop

The `thetoolswebsite.com` UI as a native desktop app — same chat, same models, plus zero-popup live disk access.

## Why it exists

The web app uses Chrome's File System Access API, which (a) resets permission to "prompt" on every page reload and (b) treats IndexedDB as best-effort. Cursor / VS Code don't have this problem because they're native apps that read live from disk. This wrapper does the same — once you open a folder, it stays open across every relaunch, no popup, ever.

## Architecture

- **Electron main** (`src/main/index.ts`) — owns the `BrowserWindow`, registers IPC handlers for `pickFolder` / `walkFolder` / `readFile` / `writeFile`. All authorized paths flow through an allowlist keyed by an opaque `rootId`.
- **Preload bridge** (`src/preload/index.ts`) — `contextBridge.exposeInMainWorld("veronumDesktop", api)` so the renderer can call `window.veronumDesktop.pickFolder()` instead of `showDirectoryPicker()`.
- **Renderer** — currently loads `https://thetoolswebsite.com` directly (v1). v2 will bundle the Next.js standalone output and run a local server.

The website detects `window.veronumDesktop` on mount; if present, the folder chip routes through the bridge and gets zero-popup native disk access. If absent (regular Chrome on the web), it falls back to `showDirectoryPicker()` as before.

## Scripts

```
npm run dev          # Hot-reload Electron + preload (changes to the renderer happen on the live site)
npm run build        # electron-vite build → out/
npm run dist:mac     # Build + sign + notarize → release/Veronum-${version}-mac.dmg
```

## Signing on macOS

Set before `npm run dist:mac`:

```
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=ABCD1234EF
```

Your existing Developer ID Application cert in Keychain gets auto-detected. To force a specific cert, also set `CSC_NAME="Developer ID Application: Your Name (TEAMID)"`.

## v1 vs v2

| | v1 (now) | v2 |
|---|---|---|
| Loads | `https://thetoolswebsite.com` | Bundled Next.js standalone, local port |
| Offline | No (UI requires internet) | Yes (UI fully local; API calls still hit cloud) |
| Updates | Instant (push to Vercel) | Re-ship .dmg |
| FS bridge | Yes | Yes |

v1 already fixes the "code disappears" bug — the bridge replaces FSA. v2 just adds offline UI.
