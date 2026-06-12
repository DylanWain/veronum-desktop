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
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import { join, relative, sep, normalize, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const SITE_URL = process.env.VERONUM_SITE_URL ?? "https://thetoolswebsite.com";

// Allowlist of directory roots the user has explicitly granted access to,
// keyed by an opaque id we hand back to the renderer. The renderer never
// sees an absolute path — only ids it can pass back to read / walk.
const grantedRoots = new Map<string, string>();

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
    const rootId = randomUUID();
    grantedRoots.set(rootId, rootAbs);
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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
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

  win.once("ready-to-show", () => win.show());

  // External links always open in the system browser — never a popup
  // Electron window. Keeps the desktop app a single, focused surface.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  void win.loadURL(SITE_URL);
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
