/**
 * IPC registration for the session readers (Claude Code, Cursor, Codex).
 *
 * Exposes read-only access to local AI-coding session transcripts over
 * the desktop bridge so the Veronum website (in the sandboxed renderer)
 * can list and render them. Every handler:
 *
 *   - returns a `{ ok, ... }` envelope (never a bare value),
 *   - never throws (all fs work is wrapped in try/catch → { ok:false, error }),
 *   - is READ-ONLY (the readers only stat/read; nothing writes to disk).
 *
 * Channels (consumed by src/preload/index.ts):
 *   claudeCode:listProjects                       → { ok, projects }
 *   claudeCode:listSessions  { projectId }        → { ok, sessions }
 *   claudeCode:getSession    { projectId, sessionId } → { ok, title, messages }
 *   cursor:available                              → { ok, available }
 *   cursor:listProjects                           → { ok, projects }
 *   cursor:listSessions      { cwd }              → { ok, sessions }
 *   cursor:getSession        { cwd, sessionId }   → { ok, title, messages }
 *   codex:available                               → { ok, available, error? }
 *   codex:listSessions                            → { ok, sessions } | { ok:false, error }
 *   codex:getSession         { sessionId }        → { ok, title, messages } | { ok:false, error }
 */
import { ipcMain } from "electron";
import * as claudeCode from "./claudeCodeReader";
import * as claudeSend from "./claudeCodeSend";
import * as cursor from "./cursorReader";
import * as codex from "./codexReader";

/** Normalize any thrown value to a string for the error envelope. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerSessionReaders(): void {
  // ── Claude Code ──────────────────────────────────────────────────────
  ipcMain.handle("claudeCode:listProjects", async () => {
    try {
      return { ok: true, projects: await claudeCode.listProjects() };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle("claudeCode:listSessions", async (_e, args: { projectId: string }) => {
    try {
      return { ok: true, sessions: await claudeCode.listSessions(args?.projectId) };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle(
    "claudeCode:getSession",
    async (_e, args: { projectId: string; sessionId: string }) => {
      try {
        const parsed = await claudeCode.getSession(args?.projectId, args?.sessionId);
        return { ok: true, ...parsed };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  );

  // Continue a Claude Code session via the user's local `claude` CLI (the
  // "free" path). Streams every stream-json line to the renderer over the
  // "claudeCode:turn" channel, then a final { done: true }. Resolves with
  // an { ok, ... } envelope when the child exits. Never throws.
  ipcMain.handle(
    "claudeCode:sendInSession",
    async (e, args: { projectId: string; sessionId: string; prompt: string }) => {
      try {
        const sender = e.sender;
        return await claudeSend.sendInSession(args, (payload) => {
          // Drop chunks if the renderer went away mid-stream; the child is
          // still SIGTERM-able via claudeCode:cancelSend.
          if (!sender.isDestroyed()) sender.send("claudeCode:turn", payload);
        });
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  ipcMain.handle(
    "claudeCode:cancelSend",
    (_e, args: { sessionId: string }) => {
      try {
        return claudeSend.cancelSend(args?.sessionId);
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  );

  // ── Cursor ───────────────────────────────────────────────────────────
  ipcMain.handle("cursor:available", () => {
    try {
      return { ok: true, available: cursor.isAvailable() };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle("cursor:listProjects", () => {
    try {
      return { ok: true, projects: cursor.listProjects() };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle("cursor:listSessions", (_e, args: { cwd: string }) => {
    try {
      return { ok: true, sessions: cursor.listSessions(args?.cwd) };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle("cursor:getSession", async (_e, args: { cwd: string; sessionId: string }) => {
    try {
      const parsed = await cursor.getSession(args?.cwd, args?.sessionId);
      return { ok: true, ...parsed };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  // ── Codex ────────────────────────────────────────────────────────────
  ipcMain.handle("codex:available", () => {
    try {
      const a = codex.isAvailable();
      return { ok: true, available: a.ok, error: a.error };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle("codex:listSessions", async () => {
    try {
      const res = await codex.listSessions();
      // res is already an { ok, ... } envelope from the reader.
      return res;
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });

  ipcMain.handle("codex:getSession", async (_e, args: { sessionId: string }) => {
    try {
      const res = await codex.getSession(args?.sessionId);
      if (!res.ok) return res;
      return { ok: true, ...res.session };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  });
}
