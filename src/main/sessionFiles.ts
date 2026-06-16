/**
 * Shared helper for the session readers: given the set of file paths a
 * conversation touched (pulled from its tool-calls) plus the session's
 * working directory, read the CURRENT on-disk content of those files for
 * the code panel.
 *
 * Why current on-disk content rather than a diff-replay of the transcript:
 * a coding session maps to a real project folder, and "the code I was
 * working on in that chat" is most useful as the actual files — browsable
 * and continuable, with no fragile patch reconstruction. Files that have
 * since been deleted/moved are simply skipped (the chat still loads).
 *
 * Bounded so a huge repo can't blow up the IPC payload or the renderer:
 * caps file count, per-file bytes, and total bytes.
 */
import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SessionFile } from "./sessionTypes";

const MAX_FILES = 60;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/** Skip obviously-binary content (a NUL byte in the first 8KB). */
function looksBinary(s: string): boolean {
  const n = Math.min(s.length, 8192);
  for (let i = 0; i < n; i++) {
    if (s.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** Resolve a touched path to absolute using cwd, read its current content
 *  off disk, and return the files that exist — tool-call order preserved,
 *  deduped, and capped. Never throws. */
export async function readTouchedFiles(
  paths: Iterable<string>,
  cwd: string | null,
): Promise<SessionFile[]> {
  const out: SessionFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of paths) {
    if (out.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) break;
    if (!raw || typeof raw !== "string") continue;
    const abs = isAbsolute(raw) ? raw : cwd ? join(cwd, raw) : raw;
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(abs, "utf8");
      if (looksBinary(content)) continue;
      // Prefer a cwd-relative path for a clean file tree; fall back to abs.
      const rel =
        cwd && abs.startsWith(cwd) ? abs.slice(cwd.length).replace(/^[/\\]/, "") : abs;
      out.push({ path: rel || abs, content });
      total += content.length;
    } catch {
      // Gone / moved / unreadable — skip; the conversation still opens.
    }
  }
  return out;
}
