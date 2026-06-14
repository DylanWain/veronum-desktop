/**
 * Locating the user's `claude` CLI from inside a packaged Electron app.
 *
 * Ported from veronum-split/main.js. Two jobs:
 *
 *   1. augmentProcessPath() — when Veronum is launched from /Applications,
 *      the process inherits the bare system PATH
 *      (`/usr/bin:/bin:/usr/sbin:/sbin`), NOT the PATH from ~/.zshrc /
 *      ~/.bashrc. So `claude` installed via bun/volta/nvm/asdf/mise or a
 *      custom pnpm prefix is invisible to spawn() → `spawn claude ENOENT`
 *      even though the user can run `claude` fine in their terminal. We
 *      resolve the real PATH by querying the login shell once and merge it
 *      into process.env.PATH.
 *
 *   2. findClaudeBin() / checkClaudeInstall() — resolve the actual binary
 *      path (or report a structured "not found" the UI can show inline).
 *
 * No exception escapes any of these; callers degrade gracefully.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const CLAUDE_BIN_CANDIDATES = [
  "/usr/local/bin/claude",
  "/opt/homebrew/bin/claude",
] as const;

/** Fallback PATH used if login-shell augmentation produced nothing. */
const FALLBACK_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Resolve the user's REAL PATH by querying their login shell in
 * interactive+login mode (`-ilc 'echo -n $PATH'`): -i sources rc files,
 * -l sources profile files; both are needed because PATH exports live in
 * either. Returns null on failure.
 */
function resolveLoginShellPath(): string | null {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execSync(`${shell} -ilc 'echo -n $PATH'`, {
      timeout: 4000,
      encoding: "utf8",
    });
    const resolved = (out || "").trim();
    return resolved || null;
  } catch (e) {
    console.warn(
      "[veronum] login-shell PATH resolution failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

// Set once by augmentProcessPath() so subsequent spawns see the real PATH.
let resolvedUserPath: string | null = null;

/**
 * Merge the login-shell PATH into process.env.PATH so every subsequent
 * spawn sees the user's real toolchain. Idempotent — a no-op after the
 * first success. Prepended so login-shell entries win on duplicate dirs.
 */
export function augmentProcessPath(): void {
  if (resolvedUserPath !== null) return; // already augmented
  const real = resolveLoginShellPath();
  if (!real) return;
  resolvedUserPath = real;
  const existing = process.env.PATH || "";
  process.env.PATH = existing ? `${real}:${existing}` : real;
  console.log(
    "[veronum] augmented PATH from login shell (entries:",
    real.split(":").length,
    ")",
  );
}

/**
 * Find the `claude` binary. Order:
 *   1. Hardcoded common install locations (fastest, covers most users).
 *   2. `command -v claude` via the augmented PATH (catches bun/volta/nvm/
 *      pnpm/asdf/mise/custom prefix).
 *   3. Return "claude" so spawn() falls back to PATH lookup.
 */
export function findClaudeBin(): string {
  for (const p of CLAUDE_BIN_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  try {
    const which = execSync("command -v claude", {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (which && existsSync(which)) return which;
  } catch {
    /* fall through */
  }
  return "claude"; // last resort — spawn() resolves via PATH
}

export interface ClaudeInstall {
  ok: boolean;
  claudePath: string | null;
  source?: "candidate" | "which";
  error?: string;
  installCommand?: string;
}

/**
 * Pre-flight install check. Reports whether resolution produced a REAL
 * filesystem path vs. the "claude" fallback. No exception escapes.
 */
export function checkClaudeInstall(): ClaudeInstall {
  for (const p of CLAUDE_BIN_CANDIDATES) {
    try {
      if (existsSync(p)) return { ok: true, claudePath: p, source: "candidate" };
    } catch {
      /* ignore */
    }
  }
  try {
    const which = execSync("command -v claude", {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    if (which && existsSync(which)) {
      return { ok: true, claudePath: which, source: "which" };
    }
  } catch {
    /* fall through */
  }
  return {
    ok: false,
    claudePath: null,
    error: "claude CLI not found",
    installCommand: "npm install -g @anthropic-ai/claude-code",
  };
}

export { FALLBACK_PATH };
