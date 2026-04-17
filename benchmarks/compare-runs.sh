#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${AI_REVIEW_BENCH_OUT:-/tmp/ai-review-benchmark}"
mkdir -p "$OUT_DIR"

run_case() {
  local label="$1"
  shift
  local extra_args=("$@")

  echo "Running $label..."
  ai-review --json --debug --metrics-out "$OUT_DIR/${label}-metrics.json" "${extra_args[@]}" > "$OUT_DIR/${label}-findings.json" 2> "$OUT_DIR/${label}-debug.log"
}

# Baseline-style run (strict fan-out, no batching, full response)
run_case "baseline" --strict --batch-mode off --response-profile full

# Optimized default run
run_case "optimized" --batch-mode agent --response-profile full

AI_REVIEW_BENCH_OUT="$OUT_DIR" python3 - <<'PYEOF'
import json, pathlib
import os
out = pathlib.Path(os.environ['AI_REVIEW_BENCH_OUT'])
bm = json.loads((out / 'baseline-metrics.json').read_text())
om = json.loads((out / 'optimized-metrics.json').read_text())
bf = json.loads((out / 'baseline-findings.json').read_text())
of = json.loads((out / 'optimized-findings.json').read_text())

def sev_dist(items):
    dist = {'critical': 0, 'warning': 0, 'info': 0}
    for it in items:
        s = it.get('severity', 'info')
        dist[s] = dist.get(s, 0) + 1
    return dist

lines = []
lines.append('ai-review benchmark summary')
lines.append('')
lines.append('metrics:')
for key in ['copilot_calls', 'total_prompt_chars', 'avg_prompt_chars', 'runtime_ms', 'deduplicated_findings_count']:
    lines.append(f'- {key}: baseline={bm.get(key, \"N/A\")} optimized={om.get(key, \"N/A\")}')
lines.append('')
lines.append(f"severity baseline={sev_dist(bf)}")
lines.append(f"severity optimized={sev_dist(of)}")
summary = '\n'.join(lines)
(out / 'summary.txt').write_text(summary)
print(summary)
PYEOF

echo "Artifacts in: $OUT_DIR"
