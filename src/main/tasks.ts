/**
 * Background task registry — long-lived processes (dev servers, watchers,
 * builds in watch mode) that must SURVIVE across the agent's tool calls.
 *
 * The agent's one-shot `bash` tool runs a child that is reaped when the
 * call returns, so `npm run dev` dies and "open localhost" fails. A task
 * here is spawned with `spawn` and NOT awaited: it stays a child of the
 * long-lived Electron main process, streams stdout+stderr to a file on
 * disk, and keeps running until it exits or is stopped. The agent reads
 * its output back by id. Mirrors Claude Code's run_in_background →
 * tasks/<id>.output model.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Task = {
  id: string;
  command: string;
  child: ChildProcess;
  outputPath: string;
  stream: WriteStream;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: number;
};

const tasks = new Map<string, Task>();
let counter = 0;

function taskDir(): string {
  return join(tmpdir(), "veronum-tasks");
}

/** Spawn a detached-from-the-tool-call process that keeps running. */
export async function startBackgroundTask(
  cwd: string,
  command: string,
): Promise<{ taskId: string; outputPath: string }> {
  await fs.mkdir(taskDir(), { recursive: true });
  counter += 1;
  const id = `bg-${counter}-${Date.now().toString(36)}`;
  const outputPath = join(taskDir(), `${id}.output`);
  const stream = createWriteStream(outputPath, { flags: "a" });
  const child = spawn("/bin/bash", ["-lc", command], { cwd, env: process.env });
  child.stdout?.on("data", (d) => stream.write(d));
  child.stderr?.on("data", (d) => stream.write(d));
  const task: Task = {
    id, command, child, outputPath, stream,
    status: "running", exitCode: null, startedAt: Date.now(),
  };
  child.on("exit", (code) => {
    task.status = "exited";
    task.exitCode = code;
    try { stream.end(`\n[task ${id} exited with code ${code}]\n`); } catch { /* ignore */ }
  });
  child.on("error", (e) => {
    task.status = "exited";
    try { stream.end(`\n[task ${id} error: ${e.message}]\n`); } catch { /* ignore */ }
  });
  tasks.set(id, task);
  return { taskId: id, outputPath };
}

/** Read the tail of a background task's output by id. */
export async function readTaskOutput(
  taskId: string,
  tailBytes = 8000,
): Promise<{ ok: boolean; status?: string; exitCode?: number | null; output?: string; error?: string }> {
  const task = tasks.get(taskId);
  if (!task) return { ok: false, error: `No background task with id ${taskId}` };
  let text = "";
  try { text = await fs.readFile(task.outputPath, "utf-8"); } catch { /* not written yet */ }
  const output = text.length > tailBytes
    ? `…(${text.length - tailBytes} earlier bytes omitted)\n${text.slice(-tailBytes)}`
    : text;
  return { ok: true, status: task.status, exitCode: task.exitCode, output: output || "(no output yet)" };
}

/** Stop a running background task. */
export function stopTask(taskId: string): { ok: boolean; error?: string } {
  const task = tasks.get(taskId);
  if (!task) return { ok: false, error: `No background task with id ${taskId}` };
  try { task.child.kill("SIGTERM"); } catch { /* ignore */ }
  task.status = "exited";
  return { ok: true };
}

/** Snapshot of all tasks — for a future monitoring panel. */
export function listTasks(): Array<{ id: string; command: string; status: string; exitCode: number | null }> {
  return [...tasks.values()].map((t) => ({
    id: t.id, command: t.command, status: t.status, exitCode: t.exitCode,
  }));
}

/** Kill every task — call on app quit so dev servers don't leak ports. */
export function killAllTasks(): void {
  for (const t of tasks.values()) {
    try { t.child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}
