/**
 * Veronum Desktop — Electron main process.
 *
 * Creates one BrowserWindow that loads the Veronum web app. In v1 it
 * points at https://thetoolswebsite.com directly (instant updates, no
 * re-ship required). v2 will switch to a locally-spawned Next.js
 * standalone server bundled into the .app so it works offline.
 *
 * The renderer is sandboxed (no Node integration, isolated world), and
 * gets desktop powers through a single bridge — window.veronumDesktop —
 * exposed by the preload script. All filesystem access flows through
 * IPC handlers registered here, so the trust boundary is auditable.
 *
 * Security posture:
 *   - nodeIntegration: false        renderer cannot require('fs') etc.
 *   - contextIsolation: true        preload runs in its own world.
 *   - sandbox: true                 renderer is OS-sandboxed.
 *   - setWindowOpenHandler          window.open() routes to system shell.
 *   - did-create-window block       no popups; everything stays in-frame.
 *   - webSecurity: true             default CORS rules apply.
 *
 * The bridge functions only operate on paths the user explicitly picked
 * via a native dialog OR previously walked. We don't accept arbitrary
 * paths from the renderer — that would let a remote site (or any XSS)
 * read the user's whole disk. Authorized paths live in a Set keyed by
 * directory id, populated on pickFolder() and queryable thereafter.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, session } from "electron";
import { promises as fs } from "node:fs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep, normalize, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { startVeronumServer } from "./server";
import { runLocalAgent } from "./agent";
import { installContextMenu } from "./context-menu";
import { killAllTasks } from "./tasks";
import { initAutoUpdate } from "./autoUpdate";
import { registerSessionReaders } from "./sessionReaders";

/** The model key for the LOCAL agent loop. Resolution order:
 *  1. ANTHROPIC_API_KEY env (dev override)
 *  2. config.json in userData: { "anthropicKey": "sk-ant-..." }
 *  The local loop calls Anthropic directly — no Vercel, no token
 *  expiry. Long-term this can be a Veronum-issued key tied to the
 *  user's plan; for now it's user-configured. */
function loadAnthropicKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const p = join(app.getPath("userData"), "config.json");
    if (existsSync(p)) {
      const c = JSON.parse(readFileSync(p, "utf-8")) as { anthropicKey?: string };
      if (typeof c.anthropicKey === "string" && c.anthropicKey) return c.anthropicKey;
    }
  } catch { /* ignore */ }
  return null;
}

// One abort controller per active agent run, keyed by renderer frame
// id, so a Stop from the UI cancels the right loop.
const agentRuns = new Map<number, AbortController>();

/**
 * Custom URL scheme registration. After this is called once and the
 * user runs the app, macOS associates `veronum://` URLs with this
 * binary — so the auth-handoff page at
 * https://thetoolswebsite.com/auth/desktop-handoff can redirect to
 * `veronum://auth?access_token=...` and macOS will reopen the app.
 *
 * In packaged builds this just works. In dev (electron-vite watching),
 * the second argument has to be the absolute path to the current
 * Electron binary so macOS knows what to launch.
 */
if (process.defaultApp) {
  // dev mode — process.argv[1] is the main script path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("veronum", process.execPath, [
      join(process.cwd(), process.argv[1] ?? ""),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("veronum");
}

// macOS delivers protocol URLs via open-url (sometimes before any
// window exists). We buffer the URL and re-emit once the renderer is
// ready. Linux/Windows use second-instance (URL is in argv).
let pendingAuthUrl: string | null = null;
let mainWindow: BrowserWindow | null = null;

function deliverAuthUrl(url: string) {
  // veronum://auth?access_token=...&refresh_token=...
  if (!url.startsWith("veronum://auth")) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("veronum:auth-callback", url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingAuthUrl = url;
  }
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverAuthUrl(url);
});

// Single-instance lock: when the user clicks a veronum:// link and
// the app's already running, macOS routes it through open-url above.
// On Windows/Linux the OS spawns a second process and we get
// second-instance — pull the URL out of the new argv.
//
// Packaged builds only: in dev, electron-vite's watch restarts race
// the dying instance for the lock — the new instance loses and
// app.quit()s, leaving NO instance running. Deep links are a
// packaged-app concern anyway (Launch Services targets the .app).
if (!process.defaultApp) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      const url = argv.find((a) => a.startsWith("veronum://"));
      if (url) deliverAuthUrl(url);
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
}

/**
 * Where the renderer loads from. Resolution order:
 *   1. VERONUM_SITE_URL — opt-in override, e.g. point at a local
 *      Veronum-site dev server during iteration on UI changes.
 *   2. The bundled Next.js standalone server we spawn at startup,
 *      reachable at http://127.0.0.1:27500 (or the next free port).
 *   3. If neither is available (build incomplete), fall back to the
 *      live deploy so the wrapper at least functions.
 */
const SITE_URL_OVERRIDE = process.env.VERONUM_SITE_URL ?? null;
const SITE_URL_FALLBACK = "https://thetoolswebsite.com";

// Dedicated storage profile. productName is "Veronum", so Electron's
// default userData would be ~/Library/Application Support/Veronum —
// the SAME directory the old /Applications/Veronum.app (bridge v1)
// uses while it runs. Two Chromium instances sharing one profile
// fight over LevelDB locks and silently corrupt localStorage /
// IndexedDB — i.e. chat history and workspace caches vanish. A
// dedicated path makes this app's storage untouchable by anything
// else. Must run before app.whenReady().
app.setPath("userData", join(app.getPath("appData"), "Veronum Desktop"));

// Allowlist of directory roots the user has explicitly granted access to,
// keyed by an opaque id we hand back to the renderer. The renderer never
// sees an absolute path — only ids it can pass back to read / walk.
//
// PERSISTED to userData/granted-roots.json — this is the Cursor model:
// Cursor stores `windowsState.lastActiveWindow.folder = "file:///path"`
// in its storage.json and re-reads files LIVE from disk on every
// launch. We do the same: the path survives relaunches, so a rootId
// cached in the renderer's IndexedDB stays valid forever and the
// workspace re-walks fresh from disk instead of relying on snapshots.
const grantedRoots = new Map<string, string>();

const rootsFile = () => join(app.getPath("userData"), "granted-roots.json");

function loadGrantedRoots(): void {
  try {
    if (!existsSync(rootsFile())) return;
    const raw = JSON.parse(readFileSync(rootsFile(), "utf-8")) as Record<string, string>;
    for (const [id, path] of Object.entries(raw)) {
      if (typeof id === "string" && typeof path === "string") grantedRoots.set(id, path);
    }
  } catch (e) {
    process.stderr.write(`[main] granted-roots load failed: ${e instanceof Error ? e.message : e}\n`);
  }
}

function saveGrantedRoots(): void {
  try {
    writeFileSync(rootsFile(), JSON.stringify(Object.fromEntries(grantedRoots), null, 2), "utf-8");
  } catch (e) {
    process.stderr.write(`[main] granted-roots save failed: ${e instanceof Error ? e.message : e}\n`);
  }
}

// Window bounds persistence — Cursor stores uiState {x, y, width,
// height} per window in storage.json; we keep one record for the
// single Veronum window so it reopens exactly where the user left it.
const boundsFile = () => join(app.getPath("userData"), "window-state.json");

type SavedBounds = { x: number; y: number; width: number; height: number };

function loadSavedBounds(): SavedBounds | null {
  try {
    if (!existsSync(boundsFile())) return null;
    const b = JSON.parse(readFileSync(boundsFile(), "utf-8")) as SavedBounds;
    if ([b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) return b;
    return null;
  } catch { return null; }
}

function persistBoundsOf(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      writeFileSync(boundsFile(), JSON.stringify(win.getBounds()), "utf-8");
    } catch { /* non-fatal */ }
  };
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  win.on("moved", debounced);
  win.on("resized", debounced);
  win.on("close", save);
}

function isInsideRoot(rootAbs: string, candidateAbs: string): boolean {
  const rel = relative(rootAbs, candidateAbs);
  return !!rel && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

function resolveAuthorized(rootId: string, relPath: string): string | null {
  const rootAbs = grantedRoots.get(rootId);
  if (!rootAbs) return null;
  // normalize() resolves "." / ".." segments so a malicious renderer
  // can't escape with "../../etc/passwd". After normalize we still
  // re-verify via isInsideRoot — belt and suspenders.
  const candidate = normalize(join(rootAbs, relPath));
  if (!candidate.startsWith(rootAbs)) return null;
  if (candidate !== rootAbs && !isInsideRoot(rootAbs, candidate)) return null;
  return candidate;
}

// Mirrors the website's filter — keeps the desktop and web modes
// producing identical workspace shapes. If Veronum-site's filter ever
// changes, update both. (Long-term: ship a shared @veronum/filters pkg.)
const SKIP_DIRS = /(^|\/)(node_modules|\.next|\.turbo|dist|build|out|\.git|vendor|target|\.cache|\.vscode|\.idea|coverage|__pycache__|\.pytest_cache|\.venv)(\/|$)/;
const ALLOWED_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "rb", "java", "kt", "swift",
  "c", "cc", "cpp", "h", "hpp",
  "html", "css", "scss", "sass", "vue", "svelte",
  "md", "mdx", "txt", "yaml", "yml", "toml", "json",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "proto",
]);
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 1_500 * 1024;
const MAX_FILE_COUNT = 250;

async function walkRoot(rootAbs: string): Promise<{
  files: { path: string; content: string }[];
  totalBytes: number;
  dropped: number;
}> {
  const files: { path: string; content: string }[] = [];
  let totalBytes = 0;
  let dropped = 0;

  async function recurse(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Deterministic sort so the dropped-tail is reproducible.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILE_COUNT) { dropped++; continue; }
      const childRel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (SKIP_DIRS.test(`/${childRel}/`)) continue;
      if (entry.isDirectory()) {
        await recurse(join(dir, entry.name), childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = (entry.name.split(".").pop() ?? "").toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;
      const abs = join(dir, entry.name);
      let stat;
      try { stat = await fs.stat(abs); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) { dropped++; continue; }
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) { dropped++; continue; }
      let content: string;
      try { content = await fs.readFile(abs, "utf-8"); } catch { dropped++; continue; }
      files.push({ path: childRel, content });
      totalBytes += content.length;
    }
  }

  await recurse(rootAbs, "");
  return { files, totalBytes, dropped };
}

function registerIpc(): void {
  // pickFolder — opens the native OS dialog, grants this root in the
  // allowlist, walks it, returns { rootId, rootName, files, totalBytes }.
  // The renderer never sees absolute paths.
  ipcMain.handle("veronum:pickFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Open a folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const rootAbs = result.filePaths[0];
    // Re-use the existing rootId when the same path was granted
    // before — keeps previously-cached renderer state (IndexedDB
    // records keyed by rootId) valid across re-picks.
    let rootId = [...grantedRoots.entries()].find(([, p]) => p === rootAbs)?.[0];
    if (!rootId) {
      rootId = randomUUID();
      grantedRoots.set(rootId, rootAbs);
      saveGrantedRoots();
    }
    const { files, totalBytes, dropped } = await walkRoot(rootAbs);
    return {
      rootId,
      rootName: rootAbs.split(sep).pop() ?? "folder",
      files,
      totalBytes,
      dropped,
    };
  });

  // walkFolder — re-walks a previously-granted root for fresh content.
  // Used when an external edit (Cursor, VS Code) changed source files
  // and the desktop wrapper wants to pick up the new bytes.
  ipcMain.handle("veronum:walkFolder", async (_, rootId: string) => {
    if (!grantedRoots.has(rootId)) return null;
    const rootAbs = grantedRoots.get(rootId)!;
    return walkRoot(rootAbs);
  });

  // readFile / writeFile — for the editor pane's per-file save flow.
  // Both resolve paths through the allowlist; out-of-root requests
  // return null without touching disk.
  ipcMain.handle("veronum:readFile", async (_, rootId: string, relPath: string) => {
    const abs = resolveAuthorized(rootId, relPath);
    if (!abs) return null;
    try { return await fs.readFile(abs, "utf-8"); }
    catch { return null; }
  });

  ipcMain.handle("veronum:writeFile", async (_, rootId: string, relPath: string, content: string) => {
    const abs = resolveAuthorized(rootId, relPath);
    if (!abs) return { ok: false, error: "out_of_root" };
    try {
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf-8");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "write_failed" };
    }
  });

  // runCommand — the Bash tool. Executes a shell command with its CWD
  // pinned to a granted root, so the agent can run `git push`, `npm
  // test`, `grep`, etc. — exactly how Claude Code's Bash tool works.
  //
  // Security posture: the command only ever runs INSIDE a directory
  // the user explicitly picked via the native dialog (grantedRoots).
  // We refuse if the rootId isn't granted. We run through `bash -lc`
  // so pipes / && / env expansion behave like a real shell. A hard
  // timeout (default 120s, cap 600s) prevents a runaway agent from
  // hanging a command forever. stdout/stderr are capped at 1 MB so a
  // chatty command can't blow up the IPC channel.
  ipcMain.handle(
    "veronum:runCommand",
    async (_, rootId: string, command: string, opts?: { timeoutMs?: number }) => {
      const cwd = grantedRoots.get(rootId);
      if (!cwd) return { ok: false, code: -1, stdout: "", stderr: "root_not_granted" };
      if (typeof command !== "string" || command.trim().length === 0) {
        return { ok: false, code: -1, stdout: "", stderr: "empty_command" };
      }
      const timeout = Math.min(Math.max(Number(opts?.timeoutMs) || 120_000, 1_000), 600_000);
      return new Promise((resolve) => {
        execFile(
          "/bin/bash",
          ["-lc", command],
          { cwd, timeout, maxBuffer: 1024 * 1024, encoding: "utf-8" },
          (err, stdout, stderr) => {
            const code = err && typeof (err as { code?: number }).code === "number"
              ? (err as { code: number }).code
              : err ? 1 : 0;
            resolve({
              ok: code === 0,
              code,
              stdout: String(stdout ?? "").slice(0, 1024 * 1024),
              stderr: String(stderr ?? "").slice(0, 1024 * 1024),
            });
          },
        );
      });
    },
  );

  // agentRun — the LOCAL agent loop. Runs the whole tool-use loop in
  // this main process: calls Anthropic directly, executes tools on the
  // real machine, streams events back to the renderer. This is the
  // Claude-Code-style local engine (no Vercel round-trip per step).
  ipcMain.handle(
    "veronum:agentRun",
    async (event, args: { rootId: string; task: string; model?: string; systemExtra?: string }) => {
      const root = grantedRoots.get(args.rootId);
      if (!root) return { ok: false, error: "root_not_granted" };
      const apiKey = loadAnthropicKey();
      if (!apiKey) {
        return { ok: false, error: "no_api_key", detail: "Set ANTHROPIC_API_KEY or add anthropicKey to config.json in the app's data folder." };
      }
      const frameId = event.sender.id;
      agentRuns.get(frameId)?.abort();
      const abort = new AbortController();
      agentRuns.set(frameId, abort);
      const send = (e: unknown) => { if (!event.sender.isDestroyed()) event.sender.send("veronum:agentEvent", e); };
      try {
        await runLocalAgent({
          root,
          task: args.task,
          apiKey,
          model: args.model || "claude-sonnet-4-6",
          systemExtra: args.systemExtra,
          onEvent: send,
          signal: abort.signal,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "agent_failed" };
      } finally {
        agentRuns.delete(frameId);
      }
    },
  );

  ipcMain.handle("veronum:agentCancel", (event) => {
    agentRuns.get(event.sender.id)?.abort();
    return { ok: true };
  });

  // platform — small surface the renderer uses to swap UX based on
  // wrapper (e.g., hide the "Download desktop app" CTA we'd otherwise
  // show on the website).
  ipcMain.handle("veronum:platform", () => ({
    isDesktop: true,
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  }));
}

async function resolveLoadUrl(): Promise<string> {
  if (SITE_URL_OVERRIDE) return SITE_URL_OVERRIDE;
  try {
    const server = await startVeronumServer();
    return server.url;
  } catch (e) {
    // The bundle may be missing in fresh-clone dev environments.
    // Fall back to the live site so the wrapper at least loads;
    // the user sees a working chat (without bridge) instead of a
    // blank window.
    process.stderr.write(
      `[main] standalone server failed to start: ${e instanceof Error ? e.message : e}\n` +
      `[main] falling back to ${SITE_URL_FALLBACK}\n`,
    );
    return SITE_URL_FALLBACK;
  }
}

async function createWindow(): Promise<void> {
  const saved = loadSavedBounds();
  const win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#000000",
    titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  persistBoundsOf(win);

  win.once("ready-to-show", () => {
    win.show();
    // If the user opened a veronum:// link before the window existed
    // (cold-launch from clicking the email), drain it now.
    if (pendingAuthUrl) {
      win.webContents.send("veronum:auth-callback", pendingAuthUrl);
      pendingAuthUrl = null;
    }
  });

  // External links always open in the system browser — never a popup
  // Electron window. Keeps the desktop app a single, focused surface.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Right-click → Copy / Paste / Cut / Select All in the composer and chat.
  installContextMenu(win);

  mainWindow = win;
  win.on("closed", () => { mainWindow = null; });

  // Clear the HTTP + service-worker/cache-storage caches on every
  // launch so the latest deployed site code ALWAYS loads — a normal
  // reload (even Cmd+Shift+R) couldn't beat Next.js's cached chunks,
  // which is why deployed fixes weren't showing up. We deliberately do
  // NOT clear localStorage or IndexedDB, so chat sessions, the project
  // file cache, and the user's login all survive.
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ["serviceworkers", "cachestorage", "shadercache"] });
  } catch (e) {
    process.stderr.write(`[main] cache clear failed: ${e instanceof Error ? e.message : e}\n`);
  }

  const url = await resolveLoadUrl();
  void win.loadURL(url);
}

app.whenReady().then(async () => {
  loadGrantedRoots();
  registerIpc();
  // Read-only IPC for local AI-coding session transcripts (Claude Code,
  // Cursor, Codex) so the website can surface them inside Veronum.
  registerSessionReaders();
  await createWindow();
  // Background auto-update: checks the GitHub Releases feed on launch +
  // every 6h, downloads newer signed builds, and offers a restart. Self-
  // disables in dev. Runs after the window is up so it never delays paint.
  initAutoUpdate();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Kill any background tasks (dev servers, watchers) so they don't leak
// ports / orphan processes after the app exits.
app.on("before-quit", () => killAllTasks());
