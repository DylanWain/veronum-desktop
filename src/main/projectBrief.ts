/**
 * Project brief — a compact, text snapshot of the project at `root`, built
 * once and injected into the agent's system prompt so it starts already
 * understanding the project instead of re-greping it every session.
 *
 * The brief has three sections, in order, each included only if it has content:
 *   # Files          — a shallow (<=2 level) file tree, one path per line
 *   # Git            — `git status --short` + `git log --oneline -5` (repos only)
 *   # Project notes  — the text of CLAUDE.md / AGENTS.md / README.md if present
 *
 * The whole brief is kept under ~6000 chars; if it overflows, the Files
 * section is truncated first (it's the most regenerable). Node builtins only.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";

const SKIP_SEGMENT = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", ".turbo",
  "vendor", "coverage", ".cache", ".venv", "__pycache__",
]);

const MAX_DEPTH = 2;
const MAX_FILE_ENTRIES = 120;
const NOTE_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"];
const NOTE_CHARS = 2000;
const STATUS_LINES = 40;
const BRIEF_CHARS = 6000;

/** Walk `root` up to MAX_DEPTH levels deep, collecting relative paths. */
async function listShallow(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (truncated) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (SKIP_SEGMENT.has(e.name)) continue;
      if (paths.length >= MAX_FILE_ENTRIES) { truncated = true; return; }
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        paths.push(`${rel}/`);
        if (depth + 1 < MAX_DEPTH) await walk(join(dir, e.name), rel, depth + 1);
      } else if (e.isFile()) {
        paths.push(rel);
      }
    }
  }
  await walk(root, "", 0);
  return { paths, truncated };
}

/** Run a git subcommand in `root`; resolves to null if git errors or it's not a repo. */
async function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf-8" }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(String(stdout).trimEnd());
    });
  });
}

/** Build the `# Files` section text (without a trailing newline), or "" if empty. */
async function filesSection(root: string): Promise<string> {
  const { paths, truncated } = await listShallow(root);
  if (paths.length === 0) return "";
  const body = paths.join("\n");
  return `# Files\n${body}${truncated ? "\n(truncated)" : ""}`;
}

/** Build the `# Git` section, or "" if `root` is not a git repo / git is unavailable. */
async function gitSection(root: string): Promise<string> {
  const status = await git(root, ["status", "--short"]);
  if (status === null) return "";
  const log = await git(root, ["log", "--oneline", "-5"]);
  const parts: string[] = ["# Git"];
  if (status) parts.push(status.split("\n").slice(0, STATUS_LINES).join("\n"));
  if (log) parts.push(log);
  return parts.join("\n");
}

/** Build the `# Project notes` section from whichever note files exist, or "". */
async function notesSection(root: string): Promise<string> {
  const blocks: string[] = [];
  for (const name of NOTE_FILES) {
    let text: string;
    try { text = await fs.readFile(join(root, name), "utf-8"); } catch { continue; }
    blocks.push(`## ${name}\n${text.slice(0, NOTE_CHARS).trimEnd()}`);
  }
  if (blocks.length === 0) return "";
  return `# Project notes\n${blocks.join("\n\n")}`;
}

/** If the brief is over the char budget, shrink the Files section first. */
function fitBudget(files: string, rest: string[]): string {
  const sections = files ? [files, ...rest] : rest;
  const full = sections.join("\n\n");
  if (full.length <= BRIEF_CHARS || !files) return full;
  const restLen = rest.join("\n\n").length;
  const room = BRIEF_CHARS - restLen - "\n\n".length - "\n(truncated)".length;
  if (room <= "# Files\n".length) return rest.join("\n\n");
  const trimmed = `${files.slice(0, room)}\n(truncated)`;
  return [trimmed, ...rest].join("\n\n");
}

export async function buildProjectBrief(root: string): Promise<string> {
  const [files, gitText, notes] = await Promise.all([
    filesSection(root),
    gitSection(root),
    notesSection(root),
  ]);
  const rest = [gitText, notes].filter((s) => s.length > 0);
  return fitBudget(files, rest);
}
