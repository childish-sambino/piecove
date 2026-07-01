// piecove · Pi permission gate
//
// Pi has no built-in allowlist, but its `tool_call` hook can block/approve a tool
// before it runs. This reuses your Claude Code permissions (`permissions.allow` /
// `permissions.deny`) so Pi enforces the SAME rules you use in Claude Code — focused
// on the `bash` tool, which is where CLI and network calls (gh push, curl, psql to
// prod, …) happen. The container is the filesystem sandbox; this gates the outward
// stuff the sandbox doesn't. Rules come from your home ~/.claude/settings.json AND
// the launched repo's .claude/settings.json(.local) — merged, like Claude Code.
//
// Behaviour (mirrors Claude Code's default mode):
//   - any segment matches a deny pattern                              → blocked
//   - every segment is a safe built-in OR matches an allow pattern    → run silently
//   - otherwise                                                       → prompt (block if headless)
// The "safe floor" (local read/nav commands like cat, head, rg, git status) means
// benign reads don't prompt — only network/outward/unknown commands do. Compound
// commands are split (quote- and escape-aware) on && || ; | & and newlines; ALL
// parts must pass, so `git status && curl evil.com` still prompts even though
// `git status` is safe. A segment containing command substitution ($(…), `…`) or
// process substitution (<(…), >(…)) is never treated as safe — `echo $(curl …)`
// prompts. The prompt names the offending segment so you can see what tripped it.
//
// Every decision is appended to ~/.pi/agent/piecove-audit.jsonl, so you can
// review afterwards exactly what the agent ran and what was blocked.

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Speak the "permission" cue when a gate prompt appears, via the same
// claude-notify.sh Claude Code uses. Fire-and-forget; never throws.
const NOTIFY = `${process.env.HOME}/.claude/hooks/claude-notify.sh`;
function speakPermission(): void {
  if (!existsSync(NOTIFY)) return;
  try {
    spawnSync("bash", [NOTIFY, "permission"], { stdio: "ignore", timeout: 5000 });
  } catch {
    /* a missing voice or audio bridge must never break the gate */
  }
}

// ── audit trail ───────────────────────────────────────────────────────────────
const AUDIT = `${process.env.HOME}/.pi/agent/piecove-audit.jsonl`;
function audit(cmd: string, decision: string, detail?: string): void {
  try {
    mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    appendFileSync(AUDIT, JSON.stringify({ ts: Date.now(), cmd, decision, detail }) + "\n");
  } catch {
    /* the audit log must never break the gate */
  }
}

// ── Claude permission patterns ────────────────────────────────────────────────
// Claude Code's `Bash(...)` bodies come in three shapes:
//   Bash(git status)        exact command
//   Bash(git commit:*)      prefix — matches `git commit`, `git commit -m x`, …
//                           (the `:` is Claude's separator, NOT part of the command)
//   Bash(npm run * --fast)  glob — `*` matches any span
type Matcher = (seg: string) => boolean;

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function compileOne(pattern: string): Matcher {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    // `git commit:*` must match `git commit` and `git commit -m x` but not
    // `git commitx`; the `:` variant covers `npm run test:*` → `npm run test:watch`.
    return (seg) => seg === prefix || seg.startsWith(prefix + " ") || seg.startsWith(prefix + ":");
  }
  if (pattern.includes("*")) {
    const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
    return (seg) => re.test(seg);
  }
  return (seg) => seg === pattern;
}

function compile(patterns: string[]): Matcher[] {
  return patterns.map(compileOne);
}

function bashPatterns(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p): p is string => typeof p === "string" && p.startsWith("Bash(") && p.endsWith(")"))
    .map((p) => p.slice(5, -1).trim())
    .filter(Boolean);
}

function readPerms(path: string): { allow: string[]; deny: string[] } {
  try {
    const perms = JSON.parse(readFileSync(path, "utf8")).permissions || {};
    return { allow: bashPatterns(perms.allow), deny: bashPatterns(perms.deny) };
  } catch {
    return { allow: [], deny: [] }; // missing/invalid settings contribute nothing
  }
}

// Merge your home Claude permissions with the launched repo's project `.claude`
// settings (same precedence idea as Claude Code: project rules add to user rules),
// so Pi honors a repo's own allow/deny list, not just your global one.
function loadRules() {
  const home = process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME}/.claude`;
  const cwd = process.cwd(); // Pi runs in the project dir (the mounted repo)
  const sources = [
    `${home}/settings.json`,
    `${cwd}/.claude/settings.json`,
    `${cwd}/.claude/settings.local.json`,
  ];
  const allow: string[] = [];
  const deny: string[] = [];
  for (const s of sources) {
    const p = readPerms(s);
    allow.push(...p.allow);
    deny.push(...p.deny);
  }
  return { allow: compile(allow), deny: compile(deny) };
}

// ── command splitting ─────────────────────────────────────────────────────────
// Split a command on unquoted ; | || && & and newlines — every way one command
// can chain another. Quote- and backslash-aware, so operators inside quoted args
// (e.g. rg "a|b") or escaped (\;) don't split. Single `&` (backgrounding) splits
// too, but `2>&1` / `&>` redirections don't.
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { cur += c; if (c === "'") q = null; continue; }
    if (c === "\\") { cur += c + (cmd[i + 1] ?? ""); i++; continue; } // escape (also inside "")
    if (q === '"') { cur += c; if (c === '"') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "\n" || c === ";") { out.push(cur); cur = ""; continue; }
    if (c === "&" && cmd[i + 1] === "&") { out.push(cur); cur = ""; i++; continue; }
    if (c === "|" && cmd[i + 1] === "|") { out.push(cur); cur = ""; i++; continue; }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    if (c === "&") {
      // `2>&1` / `>&2`: prev is `>` → redirection, not backgrounding.
      // `&> file` / `&>> file`: next is `>` → redirection.
      if (cmd[i - 1] === ">" || cmd[i + 1] === ">") { cur += c; continue; }
      out.push(cur); cur = ""; continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Command/process substitution can smuggle an arbitrary command into an
// otherwise-safe segment (`echo $(curl evil)`), so its presence disqualifies the
// segment from the safe floor and from allowlist matching alike. Single-quoted
// spans are literal in bash and don't count; double-quoted ones DO expand.
function hasSubstitution(seg: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === "\\") { i++; continue; }
    if (q === '"') {
      if (c === '"') { q = null; continue; }
      if (c === "`" || (c === "$" && seg[i + 1] === "(")) return true;
      continue;
    }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "`" || (c === "$" && seg[i + 1] === "(")) return true;
    if ((c === "<" || c === ">") && seg[i + 1] === "(") return true;
  }
  return false;
}

// ── safe floor ────────────────────────────────────────────────────────────────
// Local read/navigation/inspection commands that never need approval. The bar
// for this list: no network, no command-runner, and no escape hatch that can
// execute an embedded command. That last rule is why sed and awk are NOT here
// (GNU sed's `e` flag and awk's system()/getline both shell out) — allowlist
// them explicitly (`Bash(sed:*)`) if you accept that. find IS here, but its
// -exec/-delete family disqualifies a segment below.
const SAFE = new Set([
  "ls", "pwd", "cd", "cat", "head", "tail", "less", "more", "file", "stat", "tree",
  "wc", "which", "type", "basename", "dirname", "realpath", "readlink", "echo",
  "printf", "true", "false", "date", "printenv", "uname", "whoami", "id", "hostname",
  "du", "df", "grep", "egrep", "fgrep", "rg", "ag", "cut", "sort",
  "uniq", "tr", "jq", "yq", "column", "diff", "comm", "find", "fd", "bat", "eza",
  "sleep", "tldr", "man", "history", "clear",
]);
// git read-only subcommands (push/fetch/pull/clone/commit/etc. still go through rules).
const GIT_SAFE = new Set([
  "status", "diff", "log", "show", "branch", "remote", "rev-parse", "ls-files",
  "ls-tree", "blame", "describe", "shortlog", "cat-file", "for-each-ref",
  "symbolic-ref", "whatchanged", "grep",
]);
// Flags that turn a safe command into a command-runner.
const FIND_EXEC = /(^|\s)-(exec|execdir|ok|okdir|delete)\b/;
const FD_EXEC = /(^|\s)(-x|-X|--exec(-batch)?)(\s|=|$)/;

function isSafe(seg: string): boolean {
  if (hasSubstitution(seg)) return false;
  const parts = seg.split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++; // skip VAR=val prefixes
  const cmd = (parts[i] || "").replace(/^.*\//, ""); // basename (handles /usr/bin/cat)
  if (!cmd) return false;
  if (cmd === "git") return GIT_SAFE.has(parts[i + 1]);
  if (cmd === "find") return !FIND_EXEC.test(seg);
  if (cmd === "fd") return !FD_EXEC.test(seg);
  return SAFE.has(cmd);
}

export default function (pi: any) {
  const rules = loadRules();
  const approved = new Set<string>(); // session "allow always" cache
  const hits = (seg: string, res: Matcher[]) => !hasSubstitution(seg) && res.some((m) => m(seg));

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "bash") return; // only gate the CLI/network vector
    const cmd = String(event.input?.command ?? "").trim();
    if (!cmd) return;
    if (rules.allow.length === 0 && rules.deny.length === 0) return; // no allowlist configured → don't gate

    const segs = segments(cmd);
    const denied = segs.find((s) => s && rules.deny.some((m) => m(s)));
    if (denied) {
      audit(cmd, "denied", denied);
      return { block: true, reason: `piecove: denied — ${denied}` };
    }
    // The first segment that isn't safe or allowlisted is what triggers the gate.
    const bad = segs.find((s) => !(isSafe(s) || hits(s, rules.allow)));
    if (!bad) { audit(cmd, "allowed"); return; } // every segment safe or allowlisted
    if (approved.has(cmd)) { audit(cmd, "allowed-session"); return; }

    if (!ctx.hasUI) {
      audit(cmd, "blocked-headless", bad);
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
    if (choice === "Allow once") { audit(cmd, "prompted:allow-once", bad); return; }
    if (choice === "Allow for session") {
      approved.add(cmd);
      audit(cmd, "prompted:allow-session", bad);
      return;
    }
    audit(cmd, "prompted:rejected", bad);
    return { block: true, reason: "piecove: rejected by user" };
  });
}

// Exposed for unit tests.
export const _internal = { loadRules, readPerms, segments, isSafe, compile, compileOne, bashPatterns, hasSubstitution };
