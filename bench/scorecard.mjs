#!/usr/bin/env node
// Aggregate bench results.jsonl into a cost-vs-quality scorecard.
// Usage: node scorecard.mjs results.jsonl
import { readFileSync } from "node:fs";

const path = process.argv[2] || "results.jsonl";
const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const byModel = new Map();
for (const r of rows) {
  const m = byModel.get(r.model) || { model: r.model, tasks: 0, passed: 0, cost: 0, seconds: 0 };
  m.tasks++;
  m.passed += r.pass ? 1 : 0;
  m.cost += r.cost || 0;
  m.seconds += r.seconds || 0;
  byModel.set(r.model, m);
}

const models = [...byModel.values()].map((m) => ({
  ...m,
  quality: m.tasks ? (m.passed / m.tasks) * 100 : 0,
  costPerPass: m.passed ? m.cost / m.passed : Infinity,
}));

// Rank by cost-per-success (cheapest reliable model first); quality breaks ties.
models.sort((a, b) => a.costPerPass - b.costPerPass || b.quality - a.quality);

const usd = (n) => (!isFinite(n) ? "—" : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const best = models[0];
const frontier = models.reduce((a, b) => (b.cost > a.cost ? b : a), models[0]); // priciest = proxy for frontier

console.log("## piecove benchmark — cost vs quality\n");
console.log("| Model | Quality | Total cost | Cost/task | Cost/success | Avg s |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const m of models) {
  console.log(
    `| ${m.model} | ${m.passed}/${m.tasks} (${m.quality.toFixed(0)}%) | ${usd(m.cost)} | ${usd(m.cost / m.tasks)} | ${usd(m.costPerPass)} | ${(m.seconds / m.tasks).toFixed(0)} |`,
  );
}

console.log("");
if (best && frontier && best.model !== frontier.model && best.quality >= 80) {
  const ratio = frontier.cost > 0 ? (best.cost / frontier.cost) * 100 : 0;
  const qGap = frontier.quality - best.quality;
  console.log(
    `> **${best.model}** matched ${best.quality.toFixed(0)}% quality at **${ratio.toFixed(0)}% of ${frontier.model}'s cost**` +
      (qGap > 0 ? ` (${qGap.toFixed(0)} pts behind on quality)` : ` (same quality)`) +
      ` — the multi-provider case in one line.`,
  );
}
