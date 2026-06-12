/**
 * Local agent loop — runs ENTIRELY in the Electron main process, the
 * way Claude Code runs as a local process. The model call, the tool
 * loop, and the tool execution all happen here on the user's machine:
 *
 *   main → Anthropic Messages API (direct, key held locally)
 *        → parse tool_use blocks
 *        → execute tools DIRECTLY (fs read/write, child_process for bash)
 *        → append tool_result, loop
 *
 * No browser↔server↔browser round-trip per step, no auth-token expiry,
 * no Vercel. The renderer just sends a task and renders streamed events.
 * This is what makes the desktop app as capable + fast as Claude Code.
 *
 * Tools mirror Claude Code's set (read from the real claude-agent-sdk):
 *   read_file / edit_file / write_file / grep / glob / bash
 * edit_file uses the exact {file_path, old_string, new_string} contract.
 */
import { promises as fs } from "node:fs";
import { join, dirname, sep } from "node:path";
import { execFile } from "node:child_process";

const SKIP_DIRS = /(^|\/)(node_modules|\.next|\.turbo|dist|build|out|\.git|vendor|target|\.cache|\.vscode|\.idea|coverage|__pycache__|\.pytest_cache|\.venv)(\/|$)/;
const ALLOWED_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb", "java", "kt",
  "swift", "c", "cc", "cpp", "h", "hpp", "html", "css", "scss", "sass", "vue",
  "svelte", "md", "mdx", "txt", "yaml", "yml", "toml", "json", "sh", "bash",
  "zsh", "fish", "sql", "graphql", "proto",
]);

export type AgentEvent =
  | { type: "assistant"; text: string; calls: { name: string; input: Record<string, unknown> }[] }
  | { type: "tool-result"; name: string; ok: boolean; preview: string }
  | { type: "done"; summary: string; steps: number }
  | { type: "error"; message: string };

const SYSTEM_PROMPT = `You are Veronum's coding agent, running locally on the user's machine with direct file and shell access. You edit the user's real project files and run real commands.

Rules:
- Before editing a file, read_file it so old_string matches exactly.
- Make the smallest change that satisfies the request; match surrounding style.
- Prefer edit_file for existing files; write_file only for new files.
- You CAN run commands (npm, git, build, test) with bash. Prefer acting over asking — only ask if a request is genuinely ambiguous about WHICH file or WHAT outcome. "Run the tests", "commit and push", "what changed" are NOT ambiguous — just do them.
- When done, stop calling tools and give a 1-2 sentence summary of what you did.
- If a tool errors, read the error and adjust — don't repeat the same call.`;

const TOOLS = [
  { name: "read_file", description: "Read a file's full contents.", input_schema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path" } }, required: ["path"] } },
  { name: "edit_file", description: "Replace an exact unique substring in a file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } },
  { name: "write_file", description: "Create or overwrite a file with content.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "grep", description: "Search the workspace for a regex; returns path:line matches.", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "glob", description: "List files matching a glob (e.g. **/*.ts).", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "bash", description: "Run a shell command in the project root (npm, git, tests, builds).", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

function inside(root: string, rel: string): string | null {
  const abs = join(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (SKIP_DIRS.test(`/${rel}/`)) continue;
      if (e.isDirectory()) { if (out.length < 5000) await walk(join(dir, e.name), rel); }
      else if (e.isFile()) out.push(rel);
    }
  }
  await walk(root, "");
  return out;
}

async function runBash(root: string, command: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-lc", command], { cwd: root, timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf-8" }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      const body = `exit ${code}\n${stdout ? `--- stdout ---\n${String(stdout).slice(0, 20_000)}\n` : ""}${stderr ? `--- stderr ---\n${String(stderr).slice(0, 20_000)}\n` : ""}`;
      resolve({ ok: code === 0, out: body });
    });
  });
}

async function execTool(root: string, name: string, input: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  try {
    if (name === "read_file") {
      const abs = inside(root, s("path"));
      if (!abs) return { ok: false, content: "path escapes the project root" };
      try { return { ok: true, content: await fs.readFile(abs, "utf-8") }; }
      catch { return { ok: false, content: `File not found: ${s("path")}` }; }
    }
    if (name === "edit_file") {
      const abs = inside(root, s("path"));
      if (!abs) return { ok: false, content: "path escapes the project root" };
      let cur: string;
      try { cur = await fs.readFile(abs, "utf-8"); } catch { return { ok: false, content: `File not found: ${s("path")}. Use write_file to create it.` }; }
      const oldS = s("old_string"), newS = s("new_string");
      if (oldS === newS) return { ok: false, content: "old_string and new_string are identical" };
      const n = cur.split(oldS).length - 1;
      if (n === 0) return { ok: false, content: `old_string not found in ${s("path")}` };
      if (n > 1) return { ok: false, content: `old_string appears ${n}×; must be unique` };
      await fs.writeFile(abs, cur.replace(oldS, newS), "utf-8");
      return { ok: true, content: `Edited ${s("path")}` };
    }
    if (name === "write_file") {
      const abs = inside(root, s("path"));
      if (!abs) return { ok: false, content: "path escapes the project root" };
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, s("content"), "utf-8");
      return { ok: true, content: `Wrote ${s("path")}` };
    }
    if (name === "grep") {
      let re: RegExp;
      try { re = new RegExp(s("pattern")); } catch { return { ok: false, content: "invalid regex" }; }
      const files = await listFiles(root);
      const hits: string[] = [];
      for (const f of files) {
        const ext = (f.split(".").pop() || "").toLowerCase();
        if (!ALLOWED_EXT.has(ext)) continue;
        const abs = join(root, f);
        let txt: string;
        try { txt = await fs.readFile(abs, "utf-8"); } catch { continue; }
        const lines = txt.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) { hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`); if (hits.length >= 100) break; }
        }
        if (hits.length >= 100) break;
      }
      return { ok: true, content: hits.length ? hits.join("\n") : `No matches for /${s("pattern")}/` };
    }
    if (name === "glob") {
      const rx = "^" + s("pattern").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/ /g, ".*") + "$";
      let re: RegExp;
      try { re = new RegExp(rx); } catch { return { ok: false, content: "invalid glob" }; }
      const files = (await listFiles(root)).filter((f) => re.test(f)).slice(0, 200);
      return { ok: true, content: files.length ? files.join("\n") : `No files match ${s("pattern")}` };
    }
    if (name === "bash") {
      const r = await runBash(root, s("command"));
      return { ok: r.ok, content: r.out };
    }
    return { ok: false, content: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, content: `Tool ${name} threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

type AnthropicBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };

export async function runLocalAgent(opts: {
  root: string;
  task: string;
  apiKey: string;
  model: string;
  systemExtra?: string;
  maxSteps?: number;
  onEvent: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { root, task, apiKey, model, onEvent } = opts;
  const maxSteps = opts.maxSteps ?? 30;
  const system = opts.systemExtra ? `${SYSTEM_PROMPT}\n\n# Project conventions\n${opts.systemExtra}` : SYSTEM_PROMPT;
  // Anthropic conversation. content blocks accumulate per turn.
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: task },
  ];

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) { onEvent({ type: "error", message: "Cancelled." }); return; }

    let resp: Response;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 8000, system, messages, tools: TOOLS }),
        signal: opts.signal,
      });
    } catch (e) {
      onEvent({ type: "error", message: `Network error: ${e instanceof Error ? e.message : e}` });
      return;
    }
    if (!resp.ok) {
      onEvent({ type: "error", message: `Anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}` });
      return;
    }
    const data = (await resp.json()) as { content?: AnthropicBlock[]; stop_reason?: string };
    const blocks = data.content ?? [];
    let text = "";
    const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) text += b.text;
      else if (b.type === "tool_use" && b.id && b.name) calls.push({ id: b.id, name: b.name, input: b.input ?? {} });
    }
    onEvent({ type: "assistant", text, calls: calls.map((c) => ({ name: c.name, input: c.input })) });

    // Record the assistant turn verbatim so tool_result ids line up.
    messages.push({ role: "assistant", content: blocks });

    if (data.stop_reason !== "tool_use" || calls.length === 0) {
      onEvent({ type: "done", summary: text, steps: step + 1 });
      return;
    }

    const results: unknown[] = [];
    for (const c of calls) {
      const r = await execTool(root, c.name, c.input);
      onEvent({ type: "tool-result", name: c.name, ok: r.ok, preview: r.content.slice(0, 300) });
      results.push({ type: "tool_result", tool_use_id: c.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: "user", content: results });
  }
  onEvent({ type: "error", message: `Reached the ${maxSteps}-step limit.` });
}
