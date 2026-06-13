/**
 * Claude Code session reader.
 *
 * Lifted from veronum-split/main.js (the working implementation) and
 * ported to TypeScript. Reads two on-disk stores, both READ-ONLY:
 *
 *   1. ~/.claude/projects/<dashed-cwd>/<sessionUuid>.jsonl
 *      The conversation transcripts written by the Claude Code CLI.
 *      The dashed-dir encoding is lossy (slashes AND spaces → "-"), so
 *      the canonical cwd is recovered by reading the `cwd` field from
 *      inside the JSONL, not by reverse-decoding the dir name.
 *
 *   2. ~/Library/Application Support/Claude/claude-code-sessions/
 *        <accountId>/<orgId>/local_<sessionUuid>.json
 *      Claude Desktop's session metadata — canonical title, model, cwd,
 *      archive flag. Written by INTERACTIVE claude invocations only.
 *
 * Headless `claude --session-id X -p` runs write a JSONL but NO metadata
 * manifest, so every listing has a "manifest-less fallback" that walks
 * the projects dir directly. That parity matters: Veronum-spawned
 * sessions would otherwise vanish on refresh.
 *
 * Exports listProjects(), listSessions(cwd), getSession(cwd, sessionId).
 * We never write under ~/.claude or ~/Library/.../Claude.
 */
import { promises as fs, existsSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import {
  isBoilerplate,
  stripSystemInjections,
  stripVeronumContext,
} from "./sessionText";
import type {
  SessionProject,
  SessionSummary,
  ParsedSession,
  SessionMessage,
  MessageImage,
} from "./sessionTypes";

const CLAUDE_CODE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Claude Code's session metadata lives here — one JSON per session with
// the canonical title (the same title shown in Claude Code's native
// sidebar), cwd, model, fork info, etc.
const CLAUDE_DESKTOP_SESSIONS_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code-sessions",
);

interface SessionMetaEntry {
  uuid: string;
  title: string;
  cwd: string;
  model: string | null;
  createdAt: number;
  lastActivityAt: number;
  isArchived: boolean;
}

interface SessionMeta {
  byUuid: Map<string, SessionMetaEntry>;
  byCwd: Map<string, string[]>;
}

interface LocatedJsonl {
  path: string;
  size: number;
  mtimeMs: number;
}

interface RawJsonlObj {
  type?: string;
  summary?: unknown;
  uuid?: string;
  timestamp?: string;
  message?: { content?: unknown } | null;
}

/**
 * Encode a cwd the way Claude CLI does for ~/.claude/projects/<encoded>/.
 * realpath first (macOS symlinks /tmp → /private/tmp and the CLI follows
 * realpath), then replace every "/" AND whitespace with "-". The CLI
 * replaces BOTH slashes and spaces, so a cwd like `/Users/x/T3 Tools`
 * becomes `-Users-x-T3-Tools`. Not reversible — recover via
 * readCwdFromSession instead.
 */
function encodeClaudeCwd(cwd: string): string {
  try {
    const real = realpathSync(cwd);
    return real.replace(/[/\s]/g, "-");
  } catch {
    return cwd.replace(/[/\s]/g, "-");
  }
}

/**
 * Read the canonical `cwd` from a session JSONL by streaming 64KB chunks
 * until the first `"cwd":"…"` is found. The first user turn may carry a
 * multi-MB base64 image, so we scan up to 4MB before giving up.
 */
async function readCwdFromSession(filePath: string): Promise<string | null> {
  try {
    const fh = await fs.open(filePath, "r");
    try {
      const CHUNK = 64 * 1024;
      const MAX = 4 * 1024 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let offset = 0;
      let carry = "";
      while (offset < MAX) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
        if (bytesRead === 0) return null;
        carry += buf.subarray(0, bytesRead).toString("utf8");
        offset += bytesRead;
        const m = carry.match(/"cwd":"([^"]+)"/);
        if (m) return m[1];
        // Keep only the tail in case "cwd" straddles a chunk boundary.
        if (carry.length > 256) carry = carry.slice(-256);
      }
      return null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Find every dashed-dir under ~/.claude/projects/ whose first session has
 * cwd === target. Returns full directory paths. Falls back to a direct
 * encoding match for brand-new sessions whose JSONL hasn't flushed a cwd
 * field yet.
 */
async function dirsForCwd(targetCwd: string): Promise<string[]> {
  const out: string[] = [];
  let targetEncoded: string | null = null;
  try {
    targetEncoded = encodeClaudeCwd(targetCwd);
  } catch {
    /* ignore */
  }
  try {
    const entries = await fs.readdir(CLAUDE_CODE_PROJECTS_DIR, { withFileTypes: true });
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const dirPath = join(CLAUDE_CODE_PROJECTS_DIR, d.name);
      let files;
      try {
        files = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const jsonl = files.filter((f) => f.isFile() && f.name.endsWith(".jsonl"));
      if (jsonl.length === 0) {
        if (targetEncoded && d.name === targetEncoded) out.push(dirPath);
        continue;
      }
      let foundCwd: string | null = null;
      for (const f of jsonl) {
        foundCwd = await readCwdFromSession(join(dirPath, f.name));
        if (foundCwd) break;
      }
      if (foundCwd) {
        if (foundCwd === targetCwd) out.push(dirPath);
        continue;
      }
      if (targetEncoded && d.name === targetEncoded) out.push(dirPath);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Locate the JSONL file for a given session UUID. The dashed-dir
 *  encoding is lossy, so we scan all candidate dirs for the cwd and look
 *  for `<uuid>.jsonl`. */
async function findSessionJsonl(
  sessionUuid: string,
  cwd: string,
): Promise<LocatedJsonl | null> {
  const dirs = await dirsForCwd(cwd);
  for (const dirPath of dirs) {
    const fp = join(dirPath, sessionUuid + ".jsonl");
    try {
      const st = await fs.stat(fp);
      if (st.isFile()) return { path: fp, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Pull human-authored text out of a user-role JSONL line. */
function extractUserText(obj: RawJsonlObj): string {
  if (obj?.type !== "user" || !obj?.message?.content) return "";
  const c = obj.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((x) => x && typeof x === "object" && x.type === "text")
      .map((x) => x.text || "")
      .join(" ");
  }
  return "";
}

/** Stream-parse the first ~512KB of a session file as JSONL, stopping
 *  early once a summary or a meaningful user message is found. */
async function readFirstSessionLines(
  filePath: string,
  maxBytes = 512 * 1024,
): Promise<RawJsonlObj[]> {
  const fh = await fs.open(filePath, "r");
  try {
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let offset = 0;
    let carry = "";
    const parsed: RawJsonlObj[] = [];
    while (offset < maxBytes) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
      if (bytesRead === 0) break;
      carry += buf.subarray(0, bytesRead).toString("utf8");
      offset += bytesRead;
      const lines = carry.split("\n");
      carry = lines.pop() || ""; // last (possibly partial) line stays in carry
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          parsed.push(JSON.parse(line) as RawJsonlObj);
        } catch {
          /* skip malformed */
        }
      }
      if (parsed.some((o) => o?.type === "summary")) break;
      if (offset >= 64 * 1024) {
        const hasMeaningful = parsed.some((o) => {
          const t = extractUserText(o).trim();
          return t && !isBoilerplate(t);
        });
        if (hasMeaningful) break;
      }
    }
    if (carry.trim()) {
      try {
        parsed.push(JSON.parse(carry) as RawJsonlObj);
      } catch {
        /* skip */
      }
    }
    return parsed;
  } finally {
    await fh.close();
  }
}

/** Pick a meaningful title: summary line → first non-boilerplate user
 *  message → first user message → UUID prefix. */
function pickSessionTitle(parsed: RawJsonlObj[], sessionUuid: string): string {
  for (const obj of parsed) {
    if (obj?.type === "summary" && typeof obj.summary === "string" && obj.summary.trim()) {
      return obj.summary.trim().slice(0, 100);
    }
  }
  for (const obj of parsed) {
    const t = extractUserText(obj).trim();
    if (t && !isBoilerplate(t)) return t.slice(0, 100);
  }
  for (const obj of parsed) {
    const t = extractUserText(obj).trim();
    if (t) return t.slice(0, 100);
  }
  return sessionUuid.slice(0, 8) + "…";
}

/** Cheap top-of-file title sniff for manifest-less sessions: first
 *  summary row, else first user text. Reads only 64KB. */
async function readJsonlTitleSniff(filePath: string): Promise<string | null> {
  let fd;
  try {
    fd = await fs.open(filePath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    let firstUserText: string | null = null;
    for (const line of lines) {
      if (!line) continue;
      let obj: RawJsonlObj;
      try {
        obj = JSON.parse(line) as RawJsonlObj;
      } catch {
        continue;
      }
      if (obj.type === "summary" && typeof obj.summary === "string") {
        return obj.summary.slice(0, 80);
      }
      if (firstUserText === null && obj.type === "user" && obj.message) {
        const c = obj.message.content;
        if (typeof c === "string" && c.trim()) firstUserText = c.trim();
        else if (Array.isArray(c)) {
          for (const blk of c) {
            if (blk?.type === "text" && typeof blk.text === "string" && blk.text.trim()) {
              firstUserText = blk.text.trim();
              break;
            }
          }
        }
      }
    }
    return firstUserText ? firstUserText.slice(0, 80) : null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

/** Walk Claude Desktop's session-metadata tree, building byUuid + byCwd.
 *  Cached 5s since the user may switch projects frequently. */
let metaCache: SessionMeta | null = null;
let metaCacheAt = 0;
async function loadSessionMeta(): Promise<SessionMeta> {
  const now = Date.now();
  if (metaCache && now - metaCacheAt < 5000) return metaCache;
  const byUuid = new Map<string, SessionMetaEntry>();
  const byCwd = new Map<string, string[]>();
  try {
    if (!existsSync(CLAUDE_DESKTOP_SESSIONS_DIR)) {
      metaCache = { byUuid, byCwd };
      metaCacheAt = now;
      return metaCache;
    }
    const accounts = await fs.readdir(CLAUDE_DESKTOP_SESSIONS_DIR, { withFileTypes: true });
    for (const a of accounts) {
      if (!a.isDirectory()) continue;
      const accountDir = join(CLAUDE_DESKTOP_SESSIONS_DIR, a.name);
      const orgs = await fs.readdir(accountDir, { withFileTypes: true });
      for (const o of orgs) {
        if (!o.isDirectory()) continue;
        const orgDir = join(accountDir, o.name);
        const files = await fs.readdir(orgDir, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".json")) continue;
          const fp = join(orgDir, f.name);
          let json: Record<string, unknown>;
          try {
            const raw = await fs.readFile(fp, "utf8");
            json = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }
          const sessionUuid = json.cliSessionId as string | undefined;
          const cwd = (json.cwd || json.originCwd) as string | undefined;
          if (!sessionUuid || !cwd) continue;
          byUuid.set(sessionUuid, {
            uuid: sessionUuid,
            title: (json.title as string) || sessionUuid.slice(0, 8) + "…",
            cwd,
            model: (json.model as string) || null,
            createdAt: (json.createdAt as number) || 0,
            lastActivityAt: (json.lastActivityAt as number) || 0,
            isArchived: !!json.isArchived,
          });
          if (!byCwd.has(cwd)) byCwd.set(cwd, []);
          byCwd.get(cwd)!.push(sessionUuid);
        }
      }
    }
  } catch {
    /* tolerate a partially-readable metadata tree */
  }
  metaCache = { byUuid, byCwd };
  metaCacheAt = now;
  return metaCache;
}

/** Parse a full Claude Code session JSONL into { title, messages }.
 *  Drops tool_use/tool_result blocks, strips system injections, surfaces
 *  inline images, and collapses consecutive assistant turns into one
 *  bubble. Pure function of file contents. */
async function parseClaudeJsonl(fp: string): Promise<ParsedSession> {
  const data = await fs.readFile(fp, "utf8");
  const lines = data.split("\n").filter(Boolean);
  const messages: SessionMessage[] = [];
  let title = "";
  for (const line of lines) {
    let obj: RawJsonlObj;
    try {
      obj = JSON.parse(line) as RawJsonlObj;
    } catch {
      continue;
    }
    if (obj.type === "summary" && typeof obj.summary === "string") {
      title = obj.summary;
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const m = obj.message;
    if (!m) continue;
    let text = "";
    // A user turn carrying only tool_result blocks is tool-protocol echo,
    // not human authorship — track whether THIS turn has real text so we
    // can drop those turns and not attribute them to the human.
    let hasUserText = false;
    const turnImages: MessageImage[] = [];
    const c = m.content;
    if (typeof c === "string") {
      text = c;
      if (text.trim().length > 0) hasUserText = true;
    } else if (Array.isArray(c)) {
      // Surface ONLY text blocks; drop tool_use / tool_result so the chat
      // shows the conversation, not protocol mechanics.
      const parts: string[] = [];
      for (const blk of c) {
        if (!blk || typeof blk !== "object") continue;
        if (blk.type === "text" && typeof blk.text === "string") {
          parts.push(blk.text);
          if (blk.text.trim().length > 0) hasUserText = true;
        } else if (
          blk.type === "image" &&
          blk.source &&
          blk.source.type === "base64" &&
          typeof blk.source.media_type === "string" &&
          typeof blk.source.data === "string"
        ) {
          turnImages.push({ media_type: blk.source.media_type, data: blk.source.data });
          // An image counts as user-authored content for this turn —
          // without this, an image-only user turn would be dropped.
          if (obj.type === "user") hasUserText = true;
        }
        // tool_use + tool_result intentionally dropped.
      }
      text = parts.join("").trim();
    }
    // Strip the Veronum context digest + system-injected pseudo-XML from
    // user prompts before showing them.
    if (obj.type === "user") {
      text = stripSystemInjections(stripVeronumContext(text)).trim();
    }
    if (!text && turnImages.length === 0) continue;
    // Skip user turns that are purely tool_result protocol echoes.
    if (obj.type === "user" && !hasUserText) continue;
    messages.push({
      id: obj.uuid || `${obj.type}-${messages.length}`,
      role: obj.type,
      text,
      images: turnImages.length > 0 ? turnImages : undefined,
      timestamp: obj.timestamp || null,
    });
  }
  // Collapse consecutive assistant turns into a single bubble — Claude
  // Code emits a fresh assistant turn around every tool_use round-trip,
  // fragmenting one reply into 5–10 tiny bubbles. User turns are NOT
  // merged: each is a deliberate human input.
  const merged: SessionMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === "assistant" && msg.role === "assistant") {
      last.text = [last.text, msg.text].filter(Boolean).join("\n\n");
      if (msg.images && msg.images.length > 0) {
        last.images = [...(last.images || []), ...msg.images];
      }
      last.timestamp = msg.timestamp || last.timestamp;
    } else {
      merged.push({ ...msg });
    }
  }
  return { title, messages: merged };
}

// ── Public API ────────────────────────────────────────────────────────

/** List Claude Code projects (one per cwd), newest-active first. */
export async function listProjects(): Promise<SessionProject[]> {
  const meta = await loadSessionMeta();
  const projects: SessionProject[] = [];
  const cwdsSeen = new Set<string>();

  // Manifest-backed: group metadata sessions by cwd.
  for (const [cwd, sessionUuids] of meta.byCwd.entries()) {
    let lastActivity = 0;
    let activeCount = 0;
    for (const uuid of sessionUuids) {
      const m = meta.byUuid.get(uuid);
      if (!m || m.isArchived) continue;
      activeCount++;
      if (m.lastActivityAt > lastActivity) lastActivity = m.lastActivityAt;
    }
    if (activeCount === 0) continue;
    projects.push({
      id: cwd,
      name: basename(cwd) || cwd,
      fullPath: cwd,
      sessionCount: activeCount,
      lastMtime: lastActivity,
    });
    cwdsSeen.add(cwd);
  }

  // Manifest-less fallback: headless `claude -p` runs write a JSONL but
  // no metadata manifest. Walk the projects dir and surface each dashed
  // dir whose first JSONL has a parseable cwd not already represented.
  try {
    if (existsSync(CLAUDE_CODE_PROJECTS_DIR)) {
      const entries = await fs.readdir(CLAUDE_CODE_PROJECTS_DIR, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const dirPath = join(CLAUDE_CODE_PROJECTS_DIR, d.name);
        let files;
        try {
          files = await fs.readdir(dirPath, { withFileTypes: true });
        } catch {
          continue;
        }
        const jsonl = files.filter((f) => f.isFile() && f.name.endsWith(".jsonl"));
        if (jsonl.length === 0) continue;
        let cwd: string | null = null;
        for (const f of jsonl) {
          cwd = await readCwdFromSession(join(dirPath, f.name));
          if (cwd) break;
        }
        if (!cwd) continue;
        if (cwdsSeen.has(cwd)) continue;
        let lastMtime = 0;
        let sessionCount = 0;
        for (const f of jsonl) {
          try {
            const st = await fs.stat(join(dirPath, f.name));
            if (st.mtimeMs > lastMtime) lastMtime = st.mtimeMs;
            sessionCount++;
          } catch {
            /* skip unreadable file */
          }
        }
        if (sessionCount === 0) continue;
        projects.push({
          id: cwd,
          name: basename(cwd) || cwd,
          fullPath: cwd,
          sessionCount,
          lastMtime,
        });
        cwdsSeen.add(cwd);
      }
    }
  } catch {
    /* fallback is best-effort */
  }

  projects.sort((a, b) => b.lastMtime - a.lastMtime);
  return projects;
}

/** List sessions for a project cwd, newest-first. */
export async function listSessions(projectId: string): Promise<SessionSummary[]> {
  const meta = await loadSessionMeta();
  const sessionUuids = meta.byCwd.get(projectId) || [];
  const sessions: SessionSummary[] = [];
  const uuidsSeen = new Set<string>();

  for (const uuid of sessionUuids) {
    const m = meta.byUuid.get(uuid);
    if (!m || m.isArchived) continue;
    const located = await findSessionJsonl(uuid, projectId);
    sessions.push({
      id: uuid,
      title: m.title,
      size: located?.size ?? 0,
      mtime: m.lastActivityAt || (located?.mtimeMs ?? 0),
      model: m.model,
    });
    uuidsSeen.add(uuid);
  }

  // Manifest-less fallback: surface JSONL-only sessions (headless runs).
  try {
    const dirs = await dirsForCwd(projectId);
    for (const dirPath of dirs) {
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
        const uuid = f.name.slice(0, -".jsonl".length);
        if (uuidsSeen.has(uuid)) continue;
        const fp = join(dirPath, f.name);
        let st;
        try {
          st = await fs.stat(fp);
        } catch {
          continue;
        }
        let title = uuid.slice(0, 8) + "…";
        try {
          const sniff = await readJsonlTitleSniff(fp);
          if (sniff) title = sniff;
        } catch {
          /* leave default */
        }
        sessions.push({ id: uuid, title, size: st.size, mtime: st.mtimeMs, model: null });
        uuidsSeen.add(uuid);
      }
    }
  } catch {
    /* fallback is best-effort */
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

/** Read one session's full conversation. Returns an empty (but ok)
 *  result for fresh/pending sessions whose JSONL hasn't been flushed. */
export async function getSession(
  projectId: string,
  sessionId: string,
): Promise<ParsedSession & { freshSession?: boolean }> {
  const located = await findSessionJsonl(sessionId, projectId);
  if (!located) {
    // Freshly-created or stale-metadata session: render blank, not an
    // error. The next user turn will create the JSONL.
    return { title: "", messages: [], freshSession: true };
  }
  const parsed = await parseClaudeJsonl(located.path);
  let title = parsed.title;
  // Prefer Claude Code's canonical session title over the JSONL scrape.
  const meta = await loadSessionMeta();
  const m = meta.byUuid.get(sessionId);
  if (m?.title) title = m.title;
  return { title, messages: parsed.messages };
}

// Re-exported for internal reuse / testing; intentionally part of the
// surface so the title-sniff path stays available to callers.
export { pickSessionTitle, readFirstSessionLines };
