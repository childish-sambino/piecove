#!/usr/bin/env bash
# piecove benchmark — run a fixed task suite across models and score cost vs quality.
#
# Run this INSIDE the container (it needs `pi`, node, jq, and the cost-lab ledger).
# It is baked into the image — from the container shell:
#   bash /opt/piecove/bench/run.sh z-ai/glm-5.2 anthropic/claude-opus-4.8 openai/gpt-5.5
#
# Every model id must be served by the CURRENT provider's endpoint (e.g. all of the
# above are OpenRouter slugs when PROVIDER=openrouter — one key, many models). The
# harness registers each model with Pi, runs each task headlessly (`pi -p`), verifies
# the result deterministically, and reads the metered cost from the cost-lab ledger.
# Then scorecard.mjs prints the cost-vs-quality table.
set -uo pipefail
cd "$(dirname "$0")"

[ "$#" -ge 1 ] || { echo "usage: run.sh <model-id> [<model-id> ...]" >&2; exit 1; }
MODELS=("$@")
PROVIDER_NAME="${PI_BENCH_PROVIDER:-piecove}"
MODELS_JSON="$HOME/.pi/agent/models.json"
LEDGER="$HOME/.pi/agent/piecove-cost/latest.json"
RESULTS="${TMPDIR:-/tmp}/piecove-bench-results.jsonl"
: > "$RESULTS"
mkdir -p /tmp/bench

# Register each model under the provider so Pi accepts --model.
for m in "${MODELS[@]}"; do
  tmp=$(mktemp)
  jq --arg p "$PROVIDER_NAME" --arg id "$m" \
    '.providers[$p].models += [{"id":$id,"name":$id}] | .providers[$p].models |= unique_by(.id)' \
    "$MODELS_JSON" > "$tmp" 2>/dev/null && mv "$tmp" "$MODELS_JSON" || rm -f "$tmp"
done

task_count=$(jq length tasks.json)
echo "piecove bench · ${#MODELS[@]} models × $task_count tasks"

for m in "${MODELS[@]}"; do
  echo "── model: $m"
  for i in $(seq 0 $((task_count - 1))); do
    id=$(jq -r ".[$i].id" tasks.json)
    prompt=$(jq -r ".[$i].prompt" tasks.json)
    setup=$(jq -r ".[$i].setup // empty" tasks.json)
    verify=$(jq -r ".[$i].verify" tasks.json)

    rm -f /tmp/bench/* 2>/dev/null
    [ -n "$setup" ] && bash -c "$setup"
    rm -f "$LEDGER" 2>/dev/null

    start=$(date +%s)
    pi --provider "$PROVIDER_NAME" --model "$m" --tools read,write,edit,bash,ls,grep,find \
      -p "$prompt" >/dev/null 2>&1
    elapsed=$(( $(date +%s) - start ))

    if bash -c "$verify" >/dev/null 2>&1; then pass=true; else pass=false; fi
    cost=$(jq -r '.spend // 0' "$LEDGER" 2>/dev/null || echo 0)
    printf '  %-10s %s  cost=%s  %ss\n' "$id" "$([ "$pass" = true ] && echo PASS || echo fail)" "$cost" "$elapsed"
    jq -nc --arg model "$m" --arg task "$id" --argjson pass "$pass" --argjson cost "${cost:-0}" --argjson ms "$elapsed" \
      '{model:$model, task:$task, pass:$pass, cost:$cost, seconds:$ms}' >> "$RESULTS"
  done
done

echo ""
node ./scorecard.mjs "$RESULTS"
