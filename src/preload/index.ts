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

/** Shapes returned by the read-only session readers (Claude Code,
 *  Cursor, Codex). Mirror src/main/sessionTypes.ts. */
interface SessionProject {
  id: string;
  name: string;
  fullPath: string;
  sessionCount: number;
  lastMtime: number;
}
interface SessionSummary {
  id: string;
  title: string;
  size: number;
  mtime: number;
  model: string | null;
}
interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  images?: { media_type: string; data: string }[];
  timestamp?: string | null;
}
type SessionResult =
  | { ok: true; title: string; messages: SessionMessage[]; freshSession?: boolean }
  | { ok: false; error: string };

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

  /** Run the LOCAL agent loop in the main process (Claude-Code-style):
   *  the whole tool loop — model call + file edits + commands — runs on
   *  the machine, streaming events via onAgentEvent. Resolves when the
   *  run finishes. */
  runAgent: (args: { rootId: string; task: string; model?: string; systemExtra?: string }):
    Promise<{ ok: boolean; error?: string; detail?: string }> =>
    ipcRenderer.invoke("veronum:agentRun", args),

  /** Cancel the active local agent run. */
  cancelAgent: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("veronum:agentCancel"),

  /** Subscribe to streamed agent events (assistant text, tool results,
   *  done, error). Returns an unsubscribe fn. */
  onAgentEvent: (handler: (e: unknown) => void): (() => void) => {
    const listener = (_e: unknown, ev: unknown) => handler(ev);
    ipcRenderer.on("veronum:agentEvent", listener);
    return () => ipcRenderer.removeListener("veronum:agentEvent", listener);
  },

  /** Read-only access to local AI-coding session transcripts. The
   *  website lists projects/sessions and renders conversations from
   *  these — no popup, read live from disk. All handlers return a
   *  `{ ok, ... }` envelope and never throw. */
  claudeCode: {
    /** List Claude Code projects (one per cwd), newest-active first. */
    listProjects: (): Promise<
      { ok: true; projects: SessionProject[] } | { ok: false; error: string }
    > => ipcRenderer.invoke("claudeCode:listProjects"),
    /** List sessions within a project cwd, newest-first. */
    listSessions: (
      projectId: string,
    ): Promise<{ ok: true; sessions: SessionSummary[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke("claudeCode:listSessions", { projectId }),
    /** Read one session's full conversation. */
    getSession: (projectId: string, sessionId: string): Promise<SessionResult> =>
      ipcRenderer.invoke("claudeCode:getSession", { projectId, sessionId }),
  },

  /** Cursor `cursor-agent` CLI session transcripts (read-only). */
  cursor: {
    /** Whether Cursor's data dir exists on this machine. */
    available: (): Promise<
      { ok: true; available: boolean } | { ok: false; error: string }
    > => ipcRenderer.invoke("cursor:available"),
    /** List Cursor IDE projects, newest-first. */
    listProjects: (): Promise<
      { ok: true; projects: SessionProject[] } | { ok: false; error: string }
    > => ipcRenderer.invoke("cursor:listProjects"),
    /** List agent-transcript sessions for a workspace cwd. */
    listSessions: (
      cwd: string,
    ): Promise<{ ok: true; sessions: SessionSummary[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke("cursor:listSessions", { cwd }),
    /** Read one Cursor transcript's full conversation. */
    getSession: (cwd: string, sessionId: string): Promise<SessionResult> =>
      ipcRenderer.invoke("cursor:getSession", { cwd, sessionId }),
  },

  /** Codex (OpenAI) global session transcripts (read-only). No project
   *  concept — sessions are global. Requires `features.hooks = true` in
   *  ~/.codex/config.toml; otherwise available/listSessions report the
   *  "codex hooks not enabled" reason. */
  codex: {
    /** Whether Codex is installed AND hooks are enabled. */
    available: (): Promise<
      { ok: true; available: boolean; error?: string } | { ok: false; error: string }
    > => ipcRenderer.invoke("codex:available"),
    /** List all Codex sessions globally, newest-first. */
    listSessions: (): Promise<
      { ok: true; sessions: SessionSummary[] } | { ok: false; error: string }
    > => ipcRenderer.invoke("codex:listSessions"),
    /** Read one Codex session's full conversation by uuid. */
    getSession: (sessionId: string): Promise<SessionResult> =>
      ipcRenderer.invoke("codex:getSession", { sessionId }),
  },

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
