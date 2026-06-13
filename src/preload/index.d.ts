/**
 * Ambient types so Veronum-site (TypeScript) can declare
 * window.veronumDesktop without copying the interface around.
 *
 * Veronum-site can re-declare this with `import type` after we ship
 * the API, but for now duplicating the shape is fine — the file is
 * small and the bridge is stable.
 */
interface VdSessionProject {
  id: string;
  name: string;
  fullPath: string;
  sessionCount: number;
  lastMtime: number;
}
interface VdSessionSummary {
  id: string;
  title: string;
  size: number;
  mtime: number;
  model: string | null;
}
interface VdSessionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  images?: { media_type: string; data: string }[];
  timestamp?: string | null;
}
type VdSessionResult =
  | { ok: true; title: string; messages: VdSessionMessage[]; freshSession?: boolean }
  | { ok: false; error: string };

declare global {
  interface Window {
    veronumDesktop?: {
      pickFolder(): Promise<{
        rootId: string;
        rootName: string;
        files: { path: string; content: string }[];
        totalBytes: number;
        dropped: number;
      } | null>;
      walkFolder(rootId: string): Promise<{
        files: { path: string; content: string }[];
        totalBytes: number;
        dropped: number;
      } | null>;
      readFile(rootId: string, relPath: string): Promise<string | null>;
      writeFile(
        rootId: string,
        relPath: string,
        content: string,
      ): Promise<{ ok: true } | { ok: false; error: string }>;
      runCommand(
        rootId: string,
        command: string,
        opts?: { timeoutMs?: number },
      ): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;
      runAgent(args: { rootId: string; task: string; model?: string; systemExtra?: string }): Promise<{ ok: boolean; error?: string; detail?: string }>;
      cancelAgent(): Promise<{ ok: boolean }>;
      onAgentEvent(handler: (e: unknown) => void): () => void;
      claudeCode: {
        listProjects(): Promise<{ ok: true; projects: VdSessionProject[] } | { ok: false; error: string }>;
        listSessions(projectId: string): Promise<{ ok: true; sessions: VdSessionSummary[] } | { ok: false; error: string }>;
        getSession(projectId: string, sessionId: string): Promise<VdSessionResult>;
      };
      cursor: {
        available(): Promise<{ ok: true; available: boolean } | { ok: false; error: string }>;
        listProjects(): Promise<{ ok: true; projects: VdSessionProject[] } | { ok: false; error: string }>;
        listSessions(cwd: string): Promise<{ ok: true; sessions: VdSessionSummary[] } | { ok: false; error: string }>;
        getSession(cwd: string, sessionId: string): Promise<VdSessionResult>;
      };
      codex: {
        available(): Promise<{ ok: true; available: boolean; error?: string } | { ok: false; error: string }>;
        listSessions(): Promise<{ ok: true; sessions: VdSessionSummary[] } | { ok: false; error: string }>;
        getSession(sessionId: string): Promise<VdSessionResult>;
      };
      platform(): Promise<{
        isDesktop: true;
        platform: NodeJS.Platform;
        arch: string;
        version: string;
      }>;
      onAuthCallback(handler: (url: string) => void): () => void;
    };
  }
}

export {};
