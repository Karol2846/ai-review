#!/usr/bin/env bash
set -euo pipefail

# aggregate.sh — Collect, deduplicate, and sort findings
# Usage: aggregate.sh <workdir> <min_severity>

WORKDIR="$1"
MIN_SEVERITY="${2:-info}"

# Merge all raw JSON files into one array
find "$WORKDIR/raw" -name '*.json' -size +2c | sort | while read -r f; do
  cat "$f"
done | jq -s 'add // []' > "$WORKDIR/merged.json"

# Filter, deduplicate, and sort
jq --arg min_sev "$MIN_SEVERITY" '
  # Severity ordering
  def sev_rank:
    if . == "critical" then 0
    elif . == "warning" then 1
    elif . == "info" then 2
    else 3
    end;

  # Min severity filter
  def min_rank:
    if $min_sev == "critical" then 0
    elif $min_sev == "warning" then 1
    else 2
    end;

  # Generate fingerprint for deduplication
  def fingerprint:
    (.file + ":" + (.line|tostring) + ":" + .category + ":" + (.message|split(" ")|.[0:4]|join(" ")))
    | gsub("[^a-zA-Z0-9:/. -]"; "");

  # Filter by min severity
  [ .[] | select((.severity | sev_rank) <= min_rank) ]

  # Deduplicate: group by fingerprint, keep highest severity
  | group_by(fingerprint)
  | map(sort_by(.severity | sev_rank) | first)

  # Add fingerprint field
  | map(. + { "fingerprint": fingerprint })

  # Sort: critical first, then warning, then info; within severity by file+line
  | sort_by([(.severity | sev_rank), .file, .line])
' "$WORKDIR/merged.json" > "$WORKDIR/findings.json"
