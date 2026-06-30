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
//   - every segment of a command matches an allow pattern  → run silently
//   - any segment matches a deny pattern                    → blocked
//   - otherwise                                             → prompt (or block if headless)
// Compound commands are split on && || ; | and newlines; ALL parts must be allowed,
// so `git status && curl evil.com` still prompts even though `git*` is allowed.

import { readFileSync } from "node:fs";

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

function segments(cmd: string): string[] {
  return cmd
    .split(/\|\||&&|[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
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
    if (segs.some((s) => hits(s, rules.deny))) {
      return { block: true, reason: "piecove: command matches a denied pattern" };
    }
    if (segs.every((s) => hits(s, rules.allow))) return; // fully allowlisted
    if (approved.has(cmd)) return; // approved earlier this session

    if (!ctx.hasUI) {
      return { block: true, reason: "piecove: command not in allowlist (no UI to approve)" };
    }
    const choice = await ctx.ui.select(`piecove · not in allowlist:\n  ${cmd}`, [
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
