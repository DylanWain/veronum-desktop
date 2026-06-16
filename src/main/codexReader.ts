/**
 * Codex (OpenAI) session reader.
 *
 * Modeled on the Claude Code reader, but adapted to Codex's actual
 * on-disk "rollout" format, which differs from Claude/Cursor in two
 * important ways verified against ~/.codex on this machine:
 *
 *   1. NO projects concept. Codex sessions are GLOBAL — there's no
 *      per-cwd grouping dir. listSessions() takes no argument.
 *
 *   2. Sessions are NESTED BY DATE, not flat:
 *        ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
 *      (The task brief said flat `~/.codex/sessions/<id>.jsonl`; the
 *      real layout is date-nested. We recurse the date dirs and pull
 *      the canonical id from each file's `session_meta` line.)
 *
 *   3. Each JSONL line is `{ timestamp, type, payload }` where `type` is
 *      "session_meta" | "event_msg" | "response_item" | "turn_context".
 *      The clean, already-unwrapped chat prose lives in event_msg lines:
 *        { type:"event_msg", payload:{ type:"user_message",  message } }
 *        { type:"event_msg", payload:{ type:"agent_message", message } }
 *      (The `response_item` lines duplicate this content but are wrapped
 *      in <environment_context>/<skill>/developer-role noise, so we read
 *      the event_msg channel instead.) The model name is on a
 *      `turn_context` line (`payload.model`); cwd + id are on
 *      `session_meta` (`payload.cwd` / `payload.id`).
 *
 * isAvailable() also enforces the brief's gate: ~/.codex/config.toml must
 * declare `features.hooks = true`, else listSessions returns
 * { ok:false, error:"codex hooks not enabled" }.
 *
 * All reads are READ-ONLY. Exports isAvailable(), listSessions(),
 * getSession(sessionId).
 */
import { promises as fs, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionSummary, ParsedSession, SessionMessage } from "./sessionTypes";
import { readTouchedFiles } from "./sessionFiles";

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
const CODEX_CONFIG = join(CODEX_DIR, "config.toml");

// rollout-2026-04-21T00-19-02-<uuid>.jsonl — capture the trailing uuid.
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CodexLine {
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    model?: string;
    message?: string;
    /** custom_tool_call: tool name (e.g. "apply_patch"). */
    name?: string;
    /** custom_tool_call: the raw input (apply_patch patch body). */
    input?: string;
  };
}

export interface CodexAvailability {
  ok: boolean;
  error?: string;
}

/** True only when ~/.codex exists AND config.toml declares
 *  `features.hooks = true`. The brief gates session listing on the hook
 *  flag, so this is the single source of truth for both. */
export function isAvailable(): CodexAvailability {
  if (!existsSync(CODEX_DIR) || !existsSync(CODEX_SESSIONS_DIR)) {
    return { ok: false, error: "codex not installed" };
  }
  if (!hooksEnabled()) {
    return { ok: false, error: "codex hooks not enabled" };
  }
  return { ok: true };
}

/** Minimal TOML probe for `features.hooks = true`. We avoid a TOML dep
 *  (brief: no new heavy deps) and just look for the key under the
 *  [features] table, tolerating spacing and `true`/`"true"`. */
function hooksEnabled(): boolean {
  let raw: string;
  try {
    raw = readFileSync(CODEX_CONFIG, "utf-8");
  } catch {
    return false;
  }
  // Inline form: `features.hooks = true` (anywhere, any table).
  if (/^\s*features\.hooks\s*=\s*"?true"?\s*$/im.test(raw)) return true;
  // Table form:
  //   [features]
  //   hooks = true
  const lines = raw.split("\n");
  let inFeatures = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^\[[^\]]+\]$/.test(t)) {
      inFeatures = t === "[features]";
      continue;
    }
    if (inFeatures && /^hooks\s*=\s*"?true"?\s*$/i.test(t)) return true;
  }
  return false;
}

/** Recursively collect every rollout-*.jsonl under the date-nested
 *  sessions tree. */
async function collectRolloutFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectRolloutFiles(full)));
    } else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

/** Pull touched file paths out of a Codex apply_patch body. The format is
 *  `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File:
 *  <path>` — paths are absolute. */
function patchPaths(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    const p = m[1].trim();
    if (p) out.push(p);
  }
  return out;
}

/** Parse one Codex rollout JSONL into id + title + model + messages + the
 *  files its apply_patch calls touched. Single pass over the rollout. */
function parseCodexRollout(raw: string): {
  id: string | null;
  title: string;
  model: string | null;
  messages: SessionMessage[];
  touchedPaths: string[];
  cwd: string | null;
} {
  const lines = raw.split("\n").filter(Boolean);
  const messages: SessionMessage[] = [];
  const touched = new Set<string>();
  let id: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let title = "";
  let userIdx = 0;
  let asstIdx = 0;
  for (const line of lines) {
    let obj: CodexLine;
    try {
      obj = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const p = obj.payload;
    if (!p) continue;
    if (obj.type === "session_meta") {
      if (typeof p.id === "string") id = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
      continue;
    }
    if (obj.type === "turn_context") {
      // First turn_context model wins; keep it stable for the session.
      if (!model && typeof p.model === "string") model = p.model;
      continue;
    }
    // File edits live in apply_patch tool calls (custom_tool_call). Record
    // the absolute paths they touched so the code panel can read them.
    if (obj.type === "response_item") {
      if (p.type === "custom_tool_call" && p.name === "apply_patch" && typeof p.input === "string") {
        for (const fp of patchPaths(p.input)) touched.add(fp);
      }
      continue;
    }
    if (obj.type !== "event_msg") continue;
    // Clean prose channel: user_message / agent_message carry a plain
    // `message` string (already free of skill/environment XML).
    let role: "user" | "assistant" | null = null;
    if (p.type === "user_message") role = "user";
    else if (p.type === "agent_message") role = "assistant";
    if (!role) continue;
    const text = typeof p.message === "string" ? p.message.trim() : "";
    if (!text) continue;
    if (!title && role === "user") title = text.split("\n", 1)[0].slice(0, 100);
    const mid = role === "user" ? `u-${userIdx++}` : `a-${asstIdx++}`;
    messages.push({ id: mid, role, text });
  }
  // Collapse consecutive assistant turns into one bubble (Codex, like
  // Claude Code, emits a fresh agent_message around each tool round-trip).
  const merged: SessionMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === "assistant" && msg.role === "assistant") {
      last.text = [last.text, msg.text].filter(Boolean).join("\n\n");
    } else {
      merged.push({ ...msg });
    }
  }
  return { id, title, model, messages: merged, touchedPaths: [...touched], cwd };
}

/** Lightweight title/model/id sniff without parsing the whole file —
 *  reads the first 64KB, enough to catch session_meta + first turn. */
function sniffRollout(raw: string): { title: string; model: string | null } {
  const lines = raw.split("\n");
  let model: string | null = null;
  let title = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: CodexLine;
    try {
      obj = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const p = obj.payload;
    if (!p) continue;
    if (obj.type === "turn_context" && !model && typeof p.model === "string") {
      model = p.model;
    }
    if (
      obj.type === "event_msg" &&
      p.type === "user_message" &&
      !title &&
      typeof p.message === "string" &&
      p.message.trim()
    ) {
      title = p.message.trim().split("\n", 1)[0].slice(0, 100);
    }
    if (title && model) break;
  }
  return { title, model };
}

/** List all Codex sessions globally, newest-first. Returns the brief's
 *  hook-gate error if hooks aren't enabled. */
export async function listSessions(): Promise<
  { ok: true; sessions: SessionSummary[] } | { ok: false; error: string }
> {
  const avail = isAvailable();
  if (!avail.ok) return { ok: false, error: avail.error || "codex unavailable" };

  const files = await collectRolloutFiles(CODEX_SESSIONS_DIR);
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const fp of files) {
    let st;
    try {
      st = await fs.stat(fp);
    } catch {
      continue;
    }
    // id from filename when possible (cheap), else fall back to parsing.
    const base = fp.split("/").pop() || "";
    const m = base.match(ROLLOUT_RE);
    let id = m ? m[1] : null;
    let title = "";
    let model: string | null = null;
    try {
      const fh = await fs.open(fp, "r");
      try {
        const buf = Buffer.alloc(64 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead).toString("utf8");
        const sniff = sniffRollout(head);
        title = sniff.title;
        model = sniff.model;
        if (!id) {
          // No id in the filename — recover it from the session_meta line.
          for (const line of head.split("\n")) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line) as CodexLine;
              if (obj.type === "session_meta" && typeof obj.payload?.id === "string") {
                id = obj.payload.id;
                break;
              }
            } catch {
              /* skip */
            }
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      /* unreadable head — keep whatever id we have */
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    sessions.push({
      id,
      title: title || id.slice(0, 8) + "…",
      size: st.size,
      mtime: st.mtimeMs,
      model,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, sessions };
}

/** Locate a rollout file by session uuid across the date-nested tree. */
async function findRollout(sessionId: string): Promise<string | null> {
  const files = await collectRolloutFiles(CODEX_SESSIONS_DIR);
  // Fast path: filename embeds the uuid.
  for (const fp of files) {
    const base = fp.split("/").pop() || "";
    const m = base.match(ROLLOUT_RE);
    if (m && m[1].toLowerCase() === sessionId.toLowerCase()) return fp;
  }
  // Fallback: open files whose name didn't match and check session_meta.
  for (const fp of files) {
    try {
      const fh = await fs.open(fp, "r");
      try {
        const buf = Buffer.alloc(8 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead).toString("utf8");
        for (const line of head.split("\n")) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line) as CodexLine;
            if (
              obj.type === "session_meta" &&
              typeof obj.payload?.id === "string" &&
              obj.payload.id.toLowerCase() === sessionId.toLowerCase()
            ) {
              return fp;
            }
          } catch {
            /* skip */
          }
        }
      } finally {
        await fh.close();
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Read one Codex session's full conversation by uuid. */
export async function getSession(
  sessionId: string,
): Promise<{ ok: true; session: ParsedSession } | { ok: false; error: string }> {
  const avail = isAvailable();
  if (!avail.ok) return { ok: false, error: avail.error || "codex unavailable" };
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    return { ok: false, error: "invalid session id" };
  }
  const fp = await findRollout(sessionId);
  if (!fp) return { ok: false, error: "session not found" };
  let raw: string;
  try {
    raw = await fs.readFile(fp, "utf-8");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "read failed" };
  }
  const parsed = parseCodexRollout(raw);
  const files = await readTouchedFiles(parsed.touchedPaths, parsed.cwd);
  return { ok: true, session: { title: parsed.title, messages: parsed.messages, files } };
}
