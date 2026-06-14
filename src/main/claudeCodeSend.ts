/**
 * Claude Code session continuation — the "free" path.
 *
 * Lifted from veronum-split/main.js (the working `claudeCode:sendInSession`
 * + `claudeCode:cancelSend` handlers) and ported to TypeScript. This is the
 * NO-COST continuation: it drives the user's OWN local `claude` CLI (their
 * subscription), so there is no Anthropic API key and no metered spend.
 *
 * sendInSession() spawns:
 *
 *   claude --resume <sessionId> -p <prompt>
 *          --output-format stream-json --verbose
 *          --model opus --fallback-model sonnet
 *
 * in the session's cwd. Claude writes the new user+assistant turns to the
 * on-disk JSONL itself, so after exit the renderer just re-fetches via
 * getSession() to render the canonical state. While running, each
 * stream-json line is forwarded to the renderer over the
 * "claudeCode:turn" channel, plus a final `{ done: true }`.
 *
 * The cwd + JSONL are resolved by reusing findSessionJsonl() from
 * claudeCodeReader.ts — we do NOT duplicate the lossy-dir path logic here.
 *
 * Guards:
 *   - one in-flight send per sessionId (would race-write the JSONL);
 *   - refuse to start if another `claude --resume <id>` is already running.
 *
 * Nothing throws across the IPC boundary; every failure is an envelope.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { findSessionJsonl } from "./claudeCodeReader";
import { findClaudeBin, checkClaudeInstall, FALLBACK_PATH } from "./claudeBin";

/** Result of a continuation send. */
export interface SendResult {
  ok: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrTail?: string;
  error?: string;
}

/** A single streamed event delivered to the renderer onChunk callback.
 *  Mirrors the shape the preload bridge filters by sessionId. */
export interface TurnPayload {
  sessionId: string;
  /** A raw stream-json line from the CLI (while streaming). */
  chunk?: unknown;
  /** Set on the terminal event. */
  done?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrTail?: string;
  error?: string;
}

/** The renderer-facing input. Intentionally minimal — the model is pinned
 *  internally (opus, with a sonnet fallback) the way the source does. */
export interface SendArgs {
  projectId: string;
  sessionId: string;
  prompt: string;
}

/** sessionId → live child process, so cancelSend can find + kill it. */
const activeSends = new Map<string, ChildProcess>();

/**
 * Look for any process whose command line literally contains
 * `--resume <sessionUuid>`. Catches a prior Veronum spawn, an interactive
 * `claude --resume` on this same session, or any other CLI invocation —
 * all of which would race-write the JSONL. pgrep exits 1 on no match.
 */
function isClaudeAlreadyRunningOnSession(
  sessionUuid: string,
): Promise<{ running: boolean; match?: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        "/usr/bin/pgrep",
        ["-fl", `--resume ${sessionUuid}`],
        { timeout: 1500 },
        (err, stdout) => {
          if (err) return resolve({ running: false });
          const line = (stdout || "").trim();
          resolve({ running: line.length > 0, match: line.split("\n")[0] || "" });
        },
      );
    } catch {
      resolve({ running: false });
    }
  });
}

/**
 * Continue a Claude Code session by driving the local `claude` CLI.
 *
 * @param args     { projectId (== cwd), sessionId, prompt }
 * @param onChunk  invoked for every stream-json line and once with done.
 * @returns        an `{ ok, ... }` envelope; never throws.
 */
export async function sendInSession(
  args: SendArgs,
  onChunk: (payload: TurnPayload) => void,
): Promise<SendResult> {
  try {
    const projectId = args?.projectId;
    const sessionId = args?.sessionId;
    const prompt = args?.prompt;

    if (!sessionId || !projectId || typeof prompt !== "string" || !prompt) {
      return { ok: false, error: "projectId, sessionId, prompt all required" };
    }
    if (activeSends.has(sessionId)) {
      return {
        ok: false,
        error: "A reply is already streaming for this session. Wait or cancel it first.",
      };
    }

    // Reuse the reader's resolution: confirm the session JSONL exists and
    // recover its on-disk location for this cwd.
    const located = await findSessionJsonl(sessionId, projectId);
    if (!located) return { ok: false, error: "Session file not found on disk" };

    // Race-write guard.
    const conflict = await isClaudeAlreadyRunningOnSession(sessionId);
    if (conflict.running) {
      return {
        ok: false,
        error: `Another \`claude --resume ${sessionId.slice(0, 8)}…\` is already running. Close that process before sending from Veronum.`,
      };
    }

    // Graceful "free path unavailable" when the CLI isn't installed —
    // never let spawn() crash into `spawn claude ENOENT`.
    if (!checkClaudeInstall().ok) {
      return { ok: false, error: "claude CLI not found" };
    }
    const claudeBin = findClaudeBin();
    const cwd = projectId; // projectId IS the cwd in our model.

    // Pin the model to Opus — without --model, headless `claude --resume -p`
    // falls back to the CLI default (often Sonnet, 200k context), which
    // fails with "Prompt is too long" on long sessions the interactive TUI
    // handles fine on Opus. --fallback-model keeps shorter sessions working
    // if Opus is unreachable for the user's plan.
    const argv = [
      "--resume", sessionId,
      "--output-format", "stream-json",
      "--verbose",
      "--model", "opus",
      "--fallback-model", "sonnet",
      "-p", prompt,
    ];

    console.log(`[veronum] spawning ${claudeBin} --resume ${sessionId} in ${cwd}`);

    const child = spawn(claudeBin, argv, {
      cwd,
      env: {
        ...process.env,
        // Use the augmented login-shell PATH (set at boot) so binaries
        // installed via bun/volta/nvm/asdf/mise/pnpm-custom-prefix are
        // findable; fall back to the hardcoded list if augmentation
        // produced an empty PATH.
        PATH: process.env.PATH || FALLBACK_PATH,
      },
      // Close stdin so the CLI doesn't wait on an empty pipe.
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeSends.set(sessionId, child);

    let buffer = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // skip malformed
        }
        try {
          onChunk({ sessionId, chunk: obj });
        } catch {
          /* swallow renderer-side errors so the stream keeps flowing */
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    return await new Promise<SendResult>((resolve) => {
      // Fire-once finalize: claude's tool subprocesses (long Bash calls)
      // can hold stdio open after the main process exits, delaying `close`.
      // Resolve on whichever of exit/close/error lands first.
      let finalized = false;
      const finalize = (info: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        error?: string;
      }): void => {
        if (finalized) return;
        finalized = true;
        activeSends.delete(sessionId);
        const stderrTail = stderr.slice(-1500);
        try {
          onChunk({
            sessionId,
            done: true,
            exitCode: info.exitCode,
            signal: info.signal,
            error: info.error,
            stderrTail,
          });
        } catch {
          /* swallow */
        }
        console.log(
          `[veronum] claude --resume ${sessionId} done code=${info.exitCode} signal=${info.signal}` +
            (info.error ? ` error=${info.error}` : ""),
        );
        resolve({
          ok: !info.error && info.exitCode === 0,
          exitCode: info.exitCode,
          signal: info.signal,
          error: info.error,
          stderrTail,
        });
      };
      child.on("exit", (code, signal) => finalize({ exitCode: code, signal }));
      child.on("close", (code, signal) => finalize({ exitCode: code, signal }));
      child.on("error", (err) =>
        finalize({ exitCode: -1, signal: null, error: err.message }),
      );
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * SIGTERM the in-flight `claude --resume` child for this session, then
 * SIGKILL after 2s if it's still alive (long tool calls can trap/delay
 * SIGTERM during an await, leaving the renderer's spinner stuck).
 */
export function cancelSend(sessionId: string): { ok: boolean; error?: string } {
  try {
    const child = activeSends.get(sessionId);
    if (!child) return { ok: false, error: "no active send" };
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        if (!child.killed && child.pid) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 2000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
