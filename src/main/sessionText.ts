/**
 * Text-cleaning helpers shared by the session-JSONL parsers.
 *
 * Ported verbatim (logic-preserving) from veronum-split/main.js:
 *   - isBoilerplate / BOILERPLATE_TITLE_PATTERNS  (~1337-1351)
 *   - stripVeronumContext                          (~2995-3008)
 *   - stripSystemInjections / SYSTEM_INJECT_TAGS   (~3022-3052)
 *
 * Claude Code injects pseudo-XML (<system-reminder>, <command-*>,
 * <bash-*>, …) and a Veronum context digest into user-role turns; left
 * unstripped, the chat view renders runtime XML soup as if the human
 * typed it. These pure string functions remove that noise.
 */

/** Patterns that are NOT real user input — Claude Code injects these
 * automatically when a session resumes, when system reminders fire, etc.
 * We skip them when picking a session title so the user sees the actual
 * conversation topic. */
const BOILERPLATE_TITLE_PATTERNS: RegExp[] = [
  /^This session is being continued from a previous/i,
  /^Caveat:\s*The messages below/i,
  /^<command-(name|message|args)>/i,
  /^<system-reminder>/i,
  /^<local-command-stdout>/i,
  /^<bash-stdout>/i,
];

export function isBoilerplate(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 3) return true; // "hi", "ok", "y" — skip if we can find better
  return BOILERPLATE_TITLE_PATTERNS.some((re) => re.test(t));
}

const VERONUM_CTX_START = "<<<veronum:context-start>>>";
const VERONUM_CTX_END = "<<<veronum:context-end>>>";

export function stripVeronumContext(text: string): string {
  if (typeof text !== "string" || !text) return text;
  const start = text.indexOf(VERONUM_CTX_START);
  if (start === -1) return text;
  const endStart = text.indexOf(VERONUM_CTX_END, start + VERONUM_CTX_START.length);
  if (endStart === -1) return text; // malformed — leave alone
  const endStop = endStart + VERONUM_CTX_END.length;
  // Drop block + the leading whitespace immediately after it.
  const tail = text.slice(endStop).replace(/^\s+/, "");
  return text.slice(0, start) + tail;
}

/**
 * Strip system-injected pseudo-XML that Claude Code's runtime sticks
 * into user-role turns. Things like <task-notification>, <system-
 * reminder>, <command-*>, <local-command-*>, <bash-input>, etc. show up
 * as `type:"text"` content blocks alongside a `type:"user"` role, so the
 * JSONL parser treats them as something the human typed. Match the full
 * open→close range (greedy across newlines) and remove. If the resulting
 * text is just whitespace, the caller drops the turn.
 */
const SYSTEM_INJECT_TAGS: string[] = [
  "task-notification",
  "system-reminder",
  "command-name",
  "command-args",
  "command-message",
  "command-output",
  "command-stdout",
  "command-stderr",
  "local-command-stdout",
  "local-command-stderr",
  "user-prompt-submit-hook",
  "bash-input",
  "bash-output",
  "bash-stdout",
  "bash-stderr",
];

export function stripSystemInjections(text: string): string {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const tag of SYSTEM_INJECT_TAGS) {
    // Match <tag>...</tag> across newlines, non-greedy, multiple
    // occurrences. Self-closing form (<tag />) too.
    const block = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    const selfClose = new RegExp(`<${tag}\\b[^>]*\\/>`, "gi");
    out = out.replace(block, "").replace(selfClose, "");
  }
  // Collapse runs of blank lines left behind by the removals.
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
