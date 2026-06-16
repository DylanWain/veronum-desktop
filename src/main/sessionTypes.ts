/**
 * Shared data shapes for the session readers (Claude Code, Cursor, Codex).
 *
 * These mirror the shapes the original veronum-split / veronum-overlay
 * IPC handlers produced, so the website renderer can consume all three
 * sources through one uniform contract:
 *
 *   project  { id, name, fullPath, sessionCount, lastMtime }
 *   session  { id, title, size, mtime, model }
 *   message  { id, role, text, images?, timestamp? }
 *
 * Cursor has no per-session `model`, and Codex has no `project` concept
 * (its sessions are global) — those fields are simply absent / omitted,
 * not invented.
 */

/** A coding project — one workspace directory (`cwd`). */
export interface SessionProject {
  /** The project's absolute cwd. Doubles as the id passed back to listSessions. */
  id: string;
  name: string;
  fullPath: string;
  sessionCount: number;
  /** Most-recent activity, ms since epoch — used for sort order. */
  lastMtime: number;
}

/** A single conversation/session within a project. */
export interface SessionSummary {
  /** Opaque session id (Claude uuid, Cursor sid, Codex rollout uuid). */
  id: string;
  title: string;
  /** On-disk JSONL byte size. */
  size: number;
  /** Last-modified, ms since epoch. */
  mtime: number;
  /** Model name when known, else null. */
  model: string | null;
}

/** An inline image block (Anthropic content-array format). */
export interface MessageImage {
  media_type: string;
  data: string;
}

/** One rendered chat turn. */
export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  images?: MessageImage[];
  timestamp?: string | null;
}

/** A file the conversation worked on — surfaced in the code panel. */
export interface SessionFile {
  /** Path relative to the session's cwd when resolvable, else absolute. */
  path: string;
  content: string;
}

/** Parsed-conversation result the getSession handlers return. */
export interface ParsedSession {
  title: string;
  messages: SessionMessage[];
  /** Files the conversation created/edited/read, with their current
   *  on-disk content, for the code panel. Absent when none resolve. */
  files?: SessionFile[];
}
