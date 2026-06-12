/**
 * Veronum Desktop — preload bridge.
 *
 * This is the single trust boundary between the Veronum website
 * (running in the sandboxed renderer) and the Node-side capabilities
 * exposed by the main process. Anything reachable on
 * window.veronumDesktop is reachable to any script the renderer
 * loads — so we expose only the small typed surface the website
 * actually needs, never `ipcRenderer` itself.
 *
 * Veronum-site detects this object on mount and uses it instead of
 * the browser File System Access API. Result: no permission popup
 * ever (the OS dialog is consent enough), and code is read live from
 * disk on every session — no IndexedDB cache, no eviction risk.
 */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  /** Opens the native OS folder picker, walks the chosen tree, and
   *  returns a granted rootId + filtered files. `rootId` is opaque
   *  to the renderer; it gets passed back to readFile / writeFile /
   *  walkFolder so the main process can authorize each call. */
  pickFolder: (): Promise<{
    rootId: string;
    rootName: string;
    files: { path: string; content: string }[];
    totalBytes: number;
    dropped: number;
  } | null> => ipcRenderer.invoke("veronum:pickFolder"),

  /** Re-walks a previously-granted root for fresh content. Use this
   *  after the user signals "Reload folder" or on a focus event when
   *  external edits may have landed. */
  walkFolder: (rootId: string): Promise<{
    files: { path: string; content: string }[];
    totalBytes: number;
    dropped: number;
  } | null> => ipcRenderer.invoke("veronum:walkFolder", rootId),

  /** Reads a single file relative to a granted root. Returns null if
   *  the path escapes the root or doesn't exist. */
  readFile: (rootId: string, relPath: string): Promise<string | null> =>
    ipcRenderer.invoke("veronum:readFile", rootId, relPath),

  /** Writes a single file relative to a granted root, creating
   *  parent directories as needed. */
  writeFile: (
    rootId: string,
    relPath: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke("veronum:writeFile", rootId, relPath, content),

  /** Runs a shell command with CWD pinned to a granted root — the
   *  Bash tool. Enables git push, test runs, grep, etc. Returns the
   *  exit code + captured stdout/stderr. */
  runCommand: (
    rootId: string,
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> =>
    ipcRenderer.invoke("veronum:runCommand", rootId, command, opts),

  /** Tells the website it's running inside Veronum Desktop, plus
   *  basic platform info for UI conditionals. */
  platform: (): Promise<{
    isDesktop: true;
    platform: NodeJS.Platform;
    arch: string;
    version: string;
  }> => ipcRenderer.invoke("veronum:platform"),

  /** Subscribe to veronum://auth deep-link callbacks. Returns an
   *  unsubscribe function. The URL is the full veronum://auth?... so
   *  the handler can parse query string for access_token + refresh_token
   *  and call supabase.auth.setSession to complete sign-in in-place. */
  onAuthCallback: (handler: (url: string) => void): (() => void) => {
    const listener = (_e: unknown, url: string) => handler(url);
    ipcRenderer.on("veronum:auth-callback", listener);
    return () => ipcRenderer.removeListener("veronum:auth-callback", listener);
  },
};

contextBridge.exposeInMainWorld("veronumDesktop", api);

export type VeronumDesktopApi = typeof api;
