// piecove · cost lab
//
// The point of piecove: keep frontier-model quality without frontier-model bills.
// You can't cut what you can't see, so this extension is the instrumentation +
// control layer for LLM spend, all from Pi's lifecycle hooks:
//
//   #1 Cost ledger     — meter every call (tokens × a cross-provider price table),
//                        per-model, persisted to ~/.pi/agent/piecove-cost/. Each
//                        session's running total is snapshotted, so /resume picks
//                        up the same spend + baseline instead of restarting at $0.
//   #5 Cache meter     — track cache-read vs fresh-input tokens = your hit rate.
//   #6 Budget guard    — warn at 80%, then on breach STOP the session (confirm to
//                        stop or raise the cap; headless hard-stops). Stopping is
//                        resumable — /resume continues with the spend rehydrated.
//   #3 Router          — classify each prompt (trivial/standard/hard) and, when
//                        tier→model routes are configured, send it to the right
//                        model; otherwise run advisory and show what routing WOULD save.
//   #2 Escalation      — watch the cheap model flail (repeated tool errors) and
//                        escalate the tier (or nudge you to).
//   Visualization      — an always-on footer status (spend · saved% · cache% ·
//                        budget) sits in the corner every turn, and `/cost`
//                        expands the full dashboard: savings vs an all-frontier
//                        baseline, per-model bars, routing mix, budget gauge.
//
// Cost is computed from tokens × pricing.json (not the provider's own number) so
// GLM-on-Fireworks and Claude-on-Anthropic are directly comparable — that
// apples-to-apples view is the whole argument for going multi-provider.

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";

// ── pricing ($/1M tokens) ─────────────────────────────────────────────────────
type Price = { label: string; input: number; output: number; cacheRead: number; cacheWrite: number };
type Pricing = { baselineMatch: string; default: Price; models: (Price & { match: string })[] };

const FALLBACK: Pricing = {
  baselineMatch: "opus",
  default: { label: "unknown", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  models: [
    { match: "opus", label: "Claude Opus", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    { match: "glm", label: "GLM-5.2", input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0.75 },
    { match: "localhost", label: "Local", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ],
};

function loadPricing(): Pricing {
  for (const p of [process.env.PIECOVE_PRICING, "/opt/piecove/pricing.json"]) {
    if (p && existsSync(p)) {
      try { return { ...FALLBACK, ...JSON.parse(readFileSync(p, "utf8")) }; } catch { /* fall through */ }
    }
  }
  return FALLBACK;
}
const PRICING = loadPricing();

function priceFor(modelId: string): Price {
  const id = (modelId || "").toLowerCase();
  for (const m of PRICING.models) if (id.includes(m.match.toLowerCase())) return m;
  return PRICING.default;
}
function baselinePrice(): Price {
  return PRICING.models.find((m) => m.match.toLowerCase().includes(PRICING.baselineMatch.toLowerCase())) || PRICING.default;
}
function cheapPrice(): Price {
  // representative "standard" tier for advisory routing projections
  return PRICING.models.find((m) => /glm|deepseek|qwen/i.test(m.match)) || PRICING.default;
}
function costOf(t: Usage, p: Price): number {
  return (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6;
}

// ── usage extraction (defensive across Pi/provider shapes) ────────────────────
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
function readUsage(u: any): Usage {
  u = u || {};
  const n = (...ks: string[]) => { for (const k of ks) if (typeof u[k] === "number") return u[k]; return 0; };
  return {
    input: n("input", "inputTokens", "input_tokens", "promptTokens"),
    output: n("output", "outputTokens", "output_tokens", "completionTokens"),
    cacheRead: n("cacheRead", "cacheReadInputTokens", "cache_read_input_tokens", "cachedInputTokens"),
    cacheWrite: n("cacheWrite", "cacheCreationInputTokens", "cache_creation_input_tokens", "cacheWriteTokens"),
  };
}

// ── task classifier (router) ──────────────────────────────────────────────────
const FRONTIER_RE = /\b(architect|design|refactor|debug|root cause|race condition|concurrency|deadlock|security|vulnerab|migration|investigate|optimi[sz]e|performance|algorithm|trace through|figure out|why (is|does|are)|complex|end.to.end)\b/i;
const TRIVIAL_RE = /\b(commit message|rename|typo|reformat|format|lint|what does|explain|summar[iy]|add a comment|list |where is|show me|run the tests|what is|grep|find the)\b/i;
type Tier = "local" | "standard" | "frontier";
function classify(prompt: string): { tier: Tier; reason: string } {
  const p = prompt || "";
  const f = p.match(FRONTIER_RE);
  if (f || p.length > 1500) return { tier: "frontier", reason: f ? f[0] : "long/complex prompt" };
  const t = p.match(TRIVIAL_RE);
  if (t && p.length < 400) return { tier: "local", reason: t[0] };
  return { tier: "standard", reason: "default" };
}

// ── state ─────────────────────────────────────────────────────────────────────
type ModelAgg = { label: string; usage: Usage; cost: number; calls: number };
const state = {
  session: "ephemeral",
  sessionFile: undefined as string | undefined, // set when the session is file-backed (resumable)
  models: new Map<string, ModelAgg>(),
  baselineCost: 0, // what everything would have cost at the baseline (frontier) model
  routedCost: 0,   // what it would cost if each turn ran on its classified tier
  routes: { local: 0, standard: 0, frontier: 0 } as Record<Tier, number>,
  currentModel: process.env.MODEL || "",
  turnTier: "standard" as Tier,
  budget: parseFloat(process.env.PIECOVE_BUDGET || "") || null,
  warned: { soft: false, hard: false },
  stopped: false, // set once we've stopped the session on a budget breach
  consecErrors: 0,
  escalatedThisTurn: false,
  ledgerDir: `${process.env.HOME}/.pi/agent/piecove-cost`,
};

function totalCost(): number { let c = 0; for (const m of state.models.values()) c += m.cost; return c; }
function totalUsage(): Usage {
  const t: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of state.models.values()) { t.input += m.usage.input; t.output += m.usage.output; t.cacheRead += m.usage.cacheRead; t.cacheWrite += m.usage.cacheWrite; }
  return t;
}

// ── formatting ────────────────────────────────────────────────────────────────
const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const toks = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n}`);
function bar(frac: number, width = 16): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return "█".repeat(full) + "░".repeat(width - full);
}

// One-line always-on footer (ctx.ui.setStatus): the corner readout you never
// have to ask for. Only shows the parts that have data yet.
function statusLine(): string {
  const spend = totalCost();
  const base = state.baselineCost;
  const savedPct = base > 0 ? ((base - spend) / base) * 100 : 0;
  const u = totalUsage();
  const cacheDenom = u.input + u.cacheRead + u.cacheWrite;
  const hit = cacheDenom > 0 ? (u.cacheRead / cacheDenom) * 100 : 0;
  const parts = [usd(spend)];
  if (base > 0.0005) parts.push(`saved ${savedPct.toFixed(0)}%`);
  if (cacheDenom > 0) parts.push(`cache ${hit.toFixed(0)}%`);
  if (state.budget) {
    const bp = (spend / state.budget) * 100;
    parts.push(`${bp.toFixed(0)}% of ${usd(state.budget)}${spend >= state.budget ? " ⚠" : ""}`);
  }
  return `⛁ piecove ${parts.join(" · ")}`;
}
function updateStatus(ctx: any): void {
  try { ctx?.ui?.setStatus?.("piecove-cost", statusLine()); } catch { /* headless / no UI */ }
}

function dashboard(): string {
  const spend = totalCost();
  const base = state.baselineCost;
  const saved = base - spend;
  const savedPct = base > 0 ? (saved / base) * 100 : 0;
  const u = totalUsage();
  const cacheDenom = u.input + u.cacheRead + u.cacheWrite;
  const hit = cacheDenom > 0 ? (u.cacheRead / cacheDenom) * 100 : 0;

  const L: string[] = [];
  L.push("┌─ piecove · cost this session ─────────────────────");
  L.push(`│ spend        ${usd(spend)}`);
  L.push(`│ vs baseline  ${usd(base)}  →  saved ${usd(saved)} (${savedPct.toFixed(0)}%)`);
  L.push(`│ tokens       in ${toks(u.input)} · out ${toks(u.output)} · cached ${toks(u.cacheRead)} (${hit.toFixed(0)}% hit)`);
  if (state.budget) {
    const frac = spend / state.budget;
    L.push(`│ budget       ${usd(spend)} / ${usd(state.budget)}  [${bar(frac, 10)}] ${(frac * 100).toFixed(0)}%`);
  }
  L.push("│");
  L.push("│ by model");
  const rows = [...state.models.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const maxCost = Math.max(...rows.map((r) => r[1].cost), 1e-9);
  for (const [, m] of rows) {
    const pct = spend > 0 ? (m.cost / spend) * 100 : 0;
    L.push(`│  ${m.label.padEnd(16)} ${usd(m.cost).padStart(8)}  ${bar(m.cost / maxCost)} ${pct.toFixed(0)}%`);
  }
  const nTurns = state.routes.local + state.routes.standard + state.routes.frontier;
  if (nTurns > 0) {
    L.push("│");
    L.push(`│ routing (${nTurns} turns)`);
    const rmax = Math.max(state.routes.local, state.routes.standard, state.routes.frontier, 1);
    for (const tier of ["local", "standard", "frontier"] as Tier[]) {
      L.push(`│  ${tier.padEnd(9)} ${String(state.routes[tier]).padStart(3)}  ${bar(state.routes[tier] / rmax, 10)}`);
    }
    const routeSaved = spend - state.routedCost;
    if (routeSaved > 0.0005 && !routingActive()) {
      L.push(`│  advisory: routing to the classified tier would've cost ${usd(state.routedCost)} → save ${usd(routeSaved)} more`);
    }
  }
  L.push("└────────────────────────────────────────────────────");
  return L.join("\n");
}

// ── routing application ───────────────────────────────────────────────────────
function routeModel(tier: Tier): string | null {
  const map: Record<Tier, string | undefined> = {
    local: process.env.PIECOVE_ROUTE_LOCAL,
    standard: process.env.PIECOVE_ROUTE_STANDARD,
    frontier: process.env.PIECOVE_ROUTE_FRONTIER,
  };
  return map[tier] || null;
}
function routingActive(): boolean {
  return !!(process.env.PIECOVE_ROUTE_LOCAL || process.env.PIECOVE_ROUTE_STANDARD || process.env.PIECOVE_ROUTE_FRONTIER);
}

// ── persistence ───────────────────────────────────────────────────────────────
// Global log (all sessions) + a per-session snapshot so /resume continues the
// same running total instead of restarting at $0.
function persist(record: object): void {
  try {
    mkdirSync(state.ledgerDir, { recursive: true });
    appendFileSync(`${state.ledgerDir}/ledger.jsonl`, JSON.stringify(record) + "\n");
    writeFileSync(`${state.ledgerDir}/latest.json`, JSON.stringify(summary(), null, 2));
  } catch { /* never break the agent over telemetry */ }
  persistSnapshot();
}
function summary() {
  const u = totalUsage();
  return {
    session: state.session, spend: totalCost(), baseline: state.baselineCost,
    saved: state.baselineCost - totalCost(), usage: u, routes: state.routes,
    models: [...state.models.entries()].map(([id, m]) => ({ id, ...m })),
  };
}

// Snapshots are keyed by the session file's basename — stable across /resume, and
// what a fork hands us as previousSessionFile — so both paths find the right one.
function sessionsDir(): string { return `${state.ledgerDir}/sessions`; }
function keyFor(file?: string): string | null {
  if (!file) return null; // ephemeral sessions can't be resumed → nothing to key on
  const base = (file.split("/").pop() || "").replace(/[^A-Za-z0-9._-]/g, "_");
  return base || null;
}
function snapshot() {
  return {
    version: 1,
    sessionFile: state.sessionFile,
    baselineCost: state.baselineCost,
    routedCost: state.routedCost,
    routes: state.routes,
    warned: state.warned,
    budget: state.budget, // persist in-session budget raises so /resume respects them
    models: [...state.models.entries()].map(([id, m]) => ({ id, ...m })),
  };
}
function persistSnapshot(): void {
  const key = keyFor(state.sessionFile);
  if (!key) return;
  try {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(`${sessionsDir()}/${key}.json`, JSON.stringify(snapshot(), null, 2));
  } catch { /* telemetry never breaks the agent */ }
}
function resetAggregates(): void {
  state.models = new Map();
  state.baselineCost = 0;
  state.routedCost = 0;
  state.routes = { local: 0, standard: 0, frontier: 0 };
  state.warned = { soft: false, hard: false };
  state.stopped = false; // re-arm the budget guard for the (possibly resumed) session
  state.budget = parseFloat(process.env.PIECOVE_BUDGET || "") || null;
}
function loadSnapshotByKey(key: string | null): boolean {
  if (!key) return false;
  const p = `${sessionsDir()}/${key}.json`;
  if (!existsSync(p)) return false;
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    state.baselineCost = Number(s.baselineCost) || 0;
    state.routedCost = Number(s.routedCost) || 0;
    state.routes = { local: 0, standard: 0, frontier: 0, ...(s.routes || {}) };
    state.warned = { soft: false, hard: false, ...(s.warned || {}) };
    if (typeof s.budget === "number") state.budget = s.budget; // honor an in-session raise
    state.models = new Map((s.models || []).map((m: any) => [m.id, {
      label: String(m.label ?? "unknown"),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(m.usage || {}) },
      cost: Number(m.cost) || 0,
      calls: Number(m.calls) || 0,
    }]));
    return true;
  } catch { return false; }
}

// Budget breach → let the user stop (session is saved, resume later) or raise the
// cap. Interactive: confirm. Headless: hard-stop so a runaway can't quietly burn
// through the budget. Pairs with resume: /resume rehydrates spend + the raised cap.
async function enforceBudget(ctx: any, spend: number): Promise<void> {
  if (!state.budget) return;
  const over = `${usd(spend)} / ${usd(state.budget)}`;
  if (ctx?.hasUI && ctx?.ui?.select) {
    const STOP = "Stop the session (resume later)";
    const RAISE = "Raise the budget and keep going";
    const choice = await ctx.ui.select(`piecove: budget reached — ${over}`, [STOP, RAISE]);
    if (choice === RAISE) {
      const bump = parseFloat(process.env.PIECOVE_BUDGET || "") || state.budget; // one more budget's worth
      state.budget = state.budget + bump;
      state.warned = { soft: false, hard: false };
      persistSnapshot();
      ctx.ui.notify(`piecove: budget raised to ${usd(state.budget)} — carry on`, "info");
      return;
    }
  }
  // Stop: mark it, persist, halt this turn, and request a graceful quit. The session
  // file is saved, so `pi` then /resume continues here with the cost lab rehydrated.
  state.stopped = true;
  persistSnapshot();
  ctx?.ui?.notify?.(`piecove: budget reached (${over}) — stopping. Resume later with /resume; cost carries over.`, "error");
  try { ctx?.abort?.(); } catch { /* ignore */ }    // halt the current turn's model calls
  try { ctx?.shutdown?.(); } catch { /* ignore */ }  // graceful quit once idle (session saved)
}

// ── extension ─────────────────────────────────────────────────────────────────
export default function (pi: any) {
  pi.on("session_start", async (event: any, ctx: any) => {
    try {
      state.sessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
      state.session = state.sessionFile ?? "ephemeral";
    } catch { /* ignore */ }
    // /resume tears down and reloads this extension, so clear any prior session's
    // totals from memory, then rehydrate THIS session's running cost from disk.
    resetAggregates();
    const mine = loadSnapshotByKey(keyFor(state.sessionFile));
    // A fresh fork shares the parent's token history, so seed it from the parent.
    if (!mine && event?.reason === "fork" && event?.previousSessionFile) {
      loadSnapshotByKey(keyFor(event.previousSessionFile));
    }
    updateStatus(ctx); // show the (possibly resumed) corner readout from turn zero
  });

  // Router: classify the prompt for this turn, count it, project its cost.
  pi.on("before_agent_start", async (event: any) => {
    const { tier, reason } = classify(String(event?.prompt ?? ""));
    state.turnTier = tier;
    state.routes[tier]++;
    state.escalatedThisTurn = false;
    void reason;
  });

  // Active routing: rewrite the model for this turn when tier routes are configured.
  pi.on("before_provider_request", (event: any) => {
    const p = event?.payload;
    if (p?.model) state.currentModel = p.model;
    if (!routingActive()) return; // advisory mode: don't touch the payload
    const target = routeModel(state.turnTier);
    if (target && p) return { ...p, model: target };
    return undefined;
  });

  // Meter every assistant message.
  pi.on("message_end", async (event: any, ctx: any) => {
    const msg = event?.message;
    if (!msg || msg.role !== "assistant") return;
    const model = msg.model || msg.modelId || state.currentModel || "unknown";
    const usage = readUsage(msg.usage);
    if (!usage.input && !usage.output && !usage.cacheRead) return; // nothing to meter

    const price = priceFor(model);
    const cost = costOf(usage, price);
    const agg = state.models.get(model) || { label: price.label, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, calls: 0 };
    agg.usage.input += usage.input; agg.usage.output += usage.output; agg.usage.cacheRead += usage.cacheRead; agg.usage.cacheWrite += usage.cacheWrite;
    agg.cost += cost; agg.calls++;
    state.models.set(model, agg);

    state.baselineCost += costOf(usage, baselinePrice());
    // projected cost if this turn had run on its classified tier
    const tierPrice = state.turnTier === "local" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as Price
      : state.turnTier === "standard" ? cheapPrice() : price;
    state.routedCost += costOf(usage, tierPrice);

    persist({ ts: Date.now(), session: state.session, provider: process.env.PROVIDER || "", model, tier: state.turnTier, usage, cost });
    updateStatus(ctx); // refresh the always-on footer

    // Budget guard: warn at 80%, then STOP the session on breach (resumable).
    if (state.budget && !state.stopped) {
      const spend = totalCost();
      if (spend >= state.budget) {
        await enforceBudget(ctx, spend);
      } else if (!state.warned.soft && spend >= 0.8 * state.budget) {
        state.warned.soft = true;
        ctx?.ui?.notify?.(`piecove: 80% of budget — ${usd(spend)} / ${usd(state.budget)}`, "warning");
      }
    }
  });

  // Passive live indicator + reset per-turn error tracking.
  pi.on("turn_start", async () => { state.consecErrors = 0; });
  pi.on("agent_end", async (_e: any, ctx: any) => {
    const spend = totalCost();
    const savedPct = state.baselineCost > 0 ? ((state.baselineCost - spend) / state.baselineCost) * 100 : 0;
    ctx?.ui?.notify?.(`piecove · session ${usd(spend)} (saved ${savedPct.toFixed(0)}% vs baseline) · /cost for detail`, "info");
  });

  // Escalation: watch the cheap model flail on tool calls.
  pi.on("tool_result", async (event: any, ctx: any) => {
    const err = event?.isError ?? event?.result?.isError ?? false;
    if (!err) { state.consecErrors = 0; return; }
    state.consecErrors++;
    if (state.consecErrors >= 3 && !state.escalatedThisTurn && state.turnTier !== "frontier") {
      state.escalatedThisTurn = true;
      state.turnTier = "frontier";
      const how = routingActive() ? "escalating to the frontier tier" : "consider escalating (set PIECOVE_ROUTE_* to auto-switch)";
      ctx?.ui?.notify?.(`piecove: ${state.consecErrors} failed tool calls — ${how}`, "warning");
    }
  });

  // The visualization. `/cost json` emits the machine-readable summary (what
  // the bench harness and host-side `piecove cost` build on).
  pi.registerCommand("cost", {
    description: "Show the piecove cost dashboard (spend, savings, cache, routing, budget); `/cost json` for raw data",
    handler: async (args: string, ctx: any) => {
      if (String(args || "").trim() === "json") {
        ctx?.ui?.notify?.(JSON.stringify(summary(), null, 2), "info");
        return;
      }
      ctx?.ui?.notify?.(dashboard(), "info");
    },
  });
}

// Exposed for unit tests / the benchmark harness.
export const _internal = { classify, priceFor, baselinePrice, cheapPrice, costOf, readUsage, dashboard, statusLine, snapshot, persistSnapshot, loadSnapshotByKey, resetAggregates, keyFor, enforceBudget, state, PRICING };
