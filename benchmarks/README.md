# Benchmarks

This folder provides a lightweight benchmark flow to compare baseline and optimized ai-review runs.

## Included known-issue diff samples

- `cases/01-missing-exception-handler.diff` — should trigger architect critical findings.
- `cases/02-n-plus-one.diff` — should trigger performance warning/critical findings.

These diffs are fixtures for quality regression checks (category/severity drift).

## Compare two runs on your branch

```bash
bash benchmarks/compare-runs.sh
```

The script saves:
- metrics JSON (`/tmp/ai-review-benchmark/*-metrics.json`)
- findings JSON (`/tmp/ai-review-benchmark/*-findings.json`)
- summary report (`/tmp/ai-review-benchmark/summary.txt`)

## Suggested usage

1. Run baseline from the previous branch/revision.
2. Run optimized branch.
3. Compare:
   - copilot call count
   - total/avg prompt chars
   - runtime
   - findings total and severity distribution
4. Spot-check sample diffs from `cases/` for category/severity drift.
