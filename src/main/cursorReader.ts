/**
 * Cursor session reader.
 *
 * Lifted from veronum-overlay/lib/cursor.js and ported to TypeScript.
 * Surfaces the user's interactive `cursor-agent` CLI sessions. Reads two
 * on-disk stores, both READ-ONLY:
 *
 *   1. Cursor IDE workspaces (project discovery)
 *      ~/Library/Application Support/Cursor/User/workspaceStorage/<id>/workspace.json
 *      → `folder` is a `file:///<path>` URI for each project opened in
 *        Cursor. Its basename becomes the project name; the path is the id.
 *
 *   2. Cursor Agent CLI transcripts (interactive sessions)
 *      ~/.cursor/projects/<dashed-cwd>/agent-transcripts/<sid>/<sid>.jsonl
 *      → newline-JSON of
 *        { role:"user"|"assistant", message:{ content:[{ type, text }] } }
 *        written by `cursor-agent`. User prompts are wrapped in
 *        <user_query>…</user_query> for the model; we strip that.
 *
 * We never write to Cursor's storage.
 *
 * Exports isAvailable(), listProjects(), listSessions(cwd),
 * getSession(cwd, sessionId).
 */
import { promises as fs, statSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { SessionProject, SessionSummary, ParsedSession } from "./sessionTypes";

const CURSOR_USER_DIR = join(homedir(), "Library", "Application Support", "Cursor", "User");
const WORKSPACE_DIR = join(CURSOR_USER_DIR, "workspaceStorage");
const AGENT_PROJECTS_DIR = join(homedir(), ".cursor", "projects");

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface CursorJsonlObj {
  role?: string;
  message?: { content?: unknown } | null;
}

/** Cursor encodes a cwd into a project-dir name by dropping the leading
 *  slash, then replacing each `/` and ` ` with `-`. e.g.
 *  `/Users/x/db broken up` → `Users-x-db-broken-up`. */
export function dashedCwd(cwd: string): string {
  if (typeof cwd !== "string" || !cwd) return "";
  const out = cwd.startsWith("/") ? cwd.slice(1) : cwd;
  return out.replace(/[/\s]/g, "-");
}

/** Pull the first text-typed content block from a Cursor JSONL record. */
function extractFirstText(obj: CursorJsonlObj): string {
  if (!obj || typeof obj !== "object") return "";
  const msg = obj.message;
  if (!msg || typeof msg !== "object") return "";
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
      return c.text;
    }
  }
  return "";
}

/** Cursor wraps user prompts in <user_query>…</user_query> for the model.
 *  Strip it for display. Tolerant of a missing closing tag. */
function stripUserQueryWrapper(text: string): string {
  if (typeof text !== "string") return "";
  const open = text.indexOf("<user_query>");
  if (open === -1) return text;
  const after = text.slice(open + "<user_query>".length);
  const close = after.indexOf("</user_query>");
  if (close === -1) return after.trim();
  return after.slice(0, close).trim();
}

export function isAvailable(): boolean {
  try {
    return statSync(CURSOR_USER_DIR).isDirectory();
  } catch {
    return false;
  }
}

/** List Cursor IDE projects, newest-first, deduped by cwd. */
export function listProjects(): SessionProject[] {
  if (!isAvailable()) return [];
  let entries;
  try {
    entries = readdirSync(WORKSPACE_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: SessionProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = join(WORKSPACE_DIR, e.name, "workspace.json");
    let folder: unknown = null;
    try {
      const j = JSON.parse(readFileSync(meta, "utf-8")) as { folder?: unknown };
      folder = j.folder; // file:///<path>
    } catch {
      continue;
    }
    if (typeof folder !== "string" || !folder.startsWith("file://")) continue;
    let p: string;
    try {
      p = decodeURIComponent(folder.replace(/^file:\/\//, ""));
    } catch {
      continue;
    }
    if (!p) continue;
    let mtime = 0;
    try {
      mtime = statSync(meta).mtimeMs;
    } catch {
      /* ignore */
    }
    // Each project's id is its absolute cwd — what spawning
    // `cursor-agent --workspace <cwd>` needs and what listSessions
    // dashes back into a transcript dir.
    projects.push({
      id: p,
      name: basename(p) || p,
      fullPath: p,
      sessionCount: 0,
      lastMtime: mtime,
    });
  }
  // Dedupe — Cursor sometimes has multiple workspaceStorage entries for
  // the same folder.
  const seen = new Set<string>();
  const deduped: SessionProject[] = [];
  for (const proj of projects) {
    if (seen.has(proj.id)) continue;
    seen.add(proj.id);
    deduped.push(proj);
  }
  deduped.sort((a, b) => b.lastMtime - a.lastMtime);
  return deduped;
}

/** List `cursor-agent` CLI transcripts for a workspace cwd, newest-first.
 *  Each agent-transcripts/<sid>/<sid>.jsonl is one session. */
export function listSessions(cwd: string): SessionSummary[] {
  if (typeof cwd !== "string" || !cwd) return [];
  const dashed = dashedCwd(cwd);
  if (!dashed) return [];
  const tDir = join(AGENT_PROJECTS_DIR, dashed, "agent-transcripts");
  let entries;
  try {
    entries = readdirSync(tDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: SessionSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sid = e.name;
    if (!SAFE_ID.test(sid)) continue;
    const jsonlPath = join(tDir, sid, `${sid}.jsonl`);
    let stat;
    try {
      stat = statSync(jsonlPath);
    } catch {
      continue;
    }
    let title = "(new chat)";
    try {
      const head = readFileSync(jsonlPath, "utf-8").split("\n", 1)[0];
      const obj = JSON.parse(head) as CursorJsonlObj;
      const txt = extractFirstText(obj);
      if (txt) title = stripUserQueryWrapper(txt).split("\n", 1)[0].slice(0, 80);
    } catch {
      /* keep default title */
    }
    sessions.push({
      id: sid,
      title,
      mtime: stat.mtimeMs,
      size: stat.size,
      model: null,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

/** Parser bound to the JSONL path — preserves the original failure shape
 *  ({ ok:false }) intent by returning an empty session on read error. */
async function parseCursorJsonl(jsonlPath: string): Promise<ParsedSession> {
  let raw: string;
  try {
    raw = await fs.readFile(jsonlPath, "utf-8");
  } catch {
    return { title: "", messages: [] };
  }
  const lines = raw.split("\n").filter(Boolean);
  const messages: ParsedSession["messages"] = [];
  let title = "";
  let userIdx = 0;
  let asstIdx = 0;
  for (const line of lines) {
    let obj: CursorJsonlObj;
    try {
      obj = JSON.parse(line) as CursorJsonlObj;
    } catch {
      continue;
    }
    const role = obj.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = stripUserQueryWrapper(extractFirstText(obj));
    if (!text.trim()) continue;
    if (!title && role === "user") title = text.split("\n", 1)[0].slice(0, 80);
    const id = role === "user" ? `u-${userIdx++}` : `a-${asstIdx++}`;
    messages.push({ id, role, text });
  }
  return { title, messages };
}

/** Read every turn in a transcript and shape it for the renderer. */
export async function getSession(cwd: string, sessionId: string): Promise<ParsedSession> {
  if (typeof cwd !== "string" || !cwd) return { title: "", messages: [] };
  if (!SAFE_ID.test(String(sessionId || ""))) return { title: "", messages: [] };
  const dashed = dashedCwd(cwd);
  const jsonlPath = join(
    AGENT_PROJECTS_DIR,
    dashed,
    "agent-transcripts",
    sessionId,
    `${sessionId}.jsonl`,
  );
  return parseCursorJsonl(jsonlPath);
}
