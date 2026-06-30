// piecove · Pi permission gate
//
// Pi has no built-in allowlist, but its `tool_call` hook can block/approve a tool
// before it runs. This reuses your Claude Code permissions (~/.claude/settings.json
// `permissions.allow` / `permissions.deny`) so Pi enforces the SAME rules you use in
// Claude Code — focused on the `bash` tool, which is where CLI and network calls
// (gh push, curl, psql to prod, …) happen. The container is the filesystem sandbox;
// this gates the outward stuff the sandbox doesn't.
//
// Behaviour (mirrors Claude Code's default mode):
//   - any segment matches a deny pattern                              → blocked
//   - every segment is a safe built-in OR matches an allow pattern    → run silently
//   - otherwise                                                       → prompt (block if headless)
// The "safe floor" (local read/nav commands like cat, head, rg, git status) means
// benign reads don't prompt — only network/outward/unknown commands do. Compound
// commands are split (quote-aware) on && || ; | and newlines; ALL parts must pass,
// so `git status && curl evil.com` still prompts even though `git status` is safe.
// The prompt names the offending segment so you can see exactly what tripped it.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Speak the "permission" cue (Daniel the butler) when a gate prompt appears, via
// the same claude-notify.sh Claude Code uses. Fire-and-forget; never throws.
const NOTIFY = `${process.env.HOME}/.claude/hooks/claude-notify.sh`;
function speakPermission(): void {
  if (!existsSync(NOTIFY)) return;
  try {
    spawnSync("bash", [NOTIFY, "permission"], { stdio: "ignore", timeout: 5000 });
  } catch {
    /* a missing voice or audio bridge must never break the gate */
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

// Convert a Claude `Bash(pattern)` body into an anchored regex (`*` is a wildcard).
function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp("^" + p.split("*").map(escapeRe).join(".*") + "$"));
}

function bashPatterns(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p): p is string => typeof p === "string" && p.startsWith("Bash(") && p.endsWith(")"))
    .map((p) => p.slice(5, -1).trim())
    .filter(Boolean);
}

function loadRules() {
  const dir = process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME}/.claude`;
  let perms: any = {};
  try {
    perms = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8")).permissions || {};
  } catch {
    /* no settings → no gating */
  }
  return { allow: compile(bashPatterns(perms.allow)), deny: compile(bashPatterns(perms.deny)) };
}

// Split a command on unquoted ; | || && and newlines. Quote-aware so operators
// inside quoted args/regex (e.g. rg "whats_slipping|family_change") aren't split.
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "\n" || c === ";") { out.push(cur); cur = ""; continue; }
    if (c === "&" && cmd[i + 1] === "&") { out.push(cur); cur = ""; i++; continue; }
    if (c === "|" && cmd[i + 1] === "|") { out.push(cur); cur = ""; i++; continue; }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Safe "floor": local read/navigation/inspection commands that never need approval
// (no network, no command-runners). Mirrors Claude Code auto-approving safe reads.
const SAFE = new Set([
  "ls", "pwd", "cd", "cat", "head", "tail", "less", "more", "file", "stat", "tree",
  "wc", "which", "type", "basename", "dirname", "realpath", "readlink", "echo",
  "printf", "true", "false", "date", "printenv", "uname", "whoami", "id", "hostname",
  "du", "df", "grep", "egrep", "fgrep", "rg", "ag", "sed", "awk", "cut", "sort",
  "uniq", "tr", "jq", "yq", "column", "diff", "comm", "find", "fd", "bat", "eza",
  "sleep", "tldr", "man", "history", "clear",
]);
// git read-only subcommands (push/fetch/pull/clone/commit/etc. still go through rules).
const GIT_SAFE = new Set([
  "status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files",
  "ls-tree", "blame", "describe", "shortlog", "cat-file", "for-each-ref",
  "symbolic-ref", "whatchanged",
]);
function isSafe(seg: string): boolean {
  const parts = seg.split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++; // skip VAR=val prefixes
  const cmd = (parts[i] || "").replace(/^.*\//, ""); // basename (handles /usr/bin/cat)
  if (!cmd) return false;
  if (cmd === "git") return GIT_SAFE.has(parts[i + 1]);
  return SAFE.has(cmd);
}

export default function (pi: any) {
  const rules = loadRules();
  const approved = new Set<string>(); // session "allow always" cache
  const hits = (seg: string, res: RegExp[]) => res.some((re) => re.test(seg));

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "bash") return; // only gate the CLI/network vector
    const cmd = String(event.input?.command ?? "").trim();
    if (!cmd) return;
    if (rules.allow.length === 0 && rules.deny.length === 0) return; // no allowlist configured → don't gate

    const segs = segments(cmd);
    const denied = segs.find((s) => hits(s, rules.deny));
    if (denied) {
      return { block: true, reason: `piecove: denied — ${denied}` };
    }
    // The first segment that isn't safe or allowlisted is what triggers the gate.
    const bad = segs.find((s) => !(isSafe(s) || hits(s, rules.allow)));
    if (!bad) return; // every segment is safe or allowlisted
    if (approved.has(cmd)) return; // approved earlier this session

    if (!ctx.hasUI) {
      return { block: true, reason: `piecove: not in allowlist — ${bad}` };
    }
    // Speak the "permission" cue, then show the offending part (and the full
    // command too, if it's a compound).
    speakPermission();
    const title =
      bad === cmd
        ? `piecove · not allowed:\n  ${bad}`
        : `piecove · not allowed:\n  ${bad}\n  (full: ${cmd})`;
    const choice = await ctx.ui.select(title, [
      "Allow once",
      "Allow for session",
      "Reject",
    ]);
    if (choice === "Allow once") return;
    if (choice === "Allow for session") {
      approved.add(cmd);
      return;
    }
    return { block: true, reason: "piecove: rejected by user" };
  });
}
