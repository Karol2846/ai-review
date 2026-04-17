#!/usr/bin/env bash
set -euo pipefail

# analyze.sh — Run reviewer agents against changed files
# Usage: analyze.sh <repo_root> <workdir> <agents_csv> <max_parallel> <ai_review_home> [debug]

REPO_ROOT="$1"
WORKDIR="$2"
AGENTS_CSV="$3"
MAX_PARALLEL="$4"
AI_REVIEW_HOME="$5"
DEBUG="${6:-false}"

# Ensure copilot subprocess can authenticate.
# Copilot CLI stores OAuth token in ~/.config/github-copilot/apps.json.
# Subprocess (xargs -P) doesn't inherit the interactive session, so we extract it here.
if [[ -z "${GH_TOKEN:-}" && -z "${COPILOT_GITHUB_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]]; then
  _copilot_token="$(python3 - <<'PYEOF' 2>/dev/null
import json, os
try:
    cfg_path = os.path.expanduser('~/.copilot/config.json')
    apps_path = os.path.expanduser('~/.config/github-copilot/apps.json')
    cfg = json.load(open(cfg_path))
    logged_in = (cfg.get('lastLoggedInUser') or {}).get('login', '')
    apps = json.load(open(apps_path))
    for v in apps.values():
        if not logged_in or v.get('user') == logged_in:
            tok = v.get('oauth_token', '')
            if tok:
                print(tok)
                break
except Exception:
    pass
PYEOF
  )"
  [[ -n "$_copilot_token" ]] && export COPILOT_GITHUB_TOKEN="$_copilot_token"
fi

DIM='\033[2m'
NC='\033[0m'

IFS=',' read -ra AGENTS <<< "$AGENTS_CSV"
mkdir -p "$WORKDIR/raw" "$WORKDIR/logs"
[[ "$DEBUG" == "true" ]] && mkdir -p "$WORKDIR/debug"

CHANGED_FILES=()
while IFS= read -r line; do
  CHANGED_FILES+=("$line")
done < "$WORKDIR/changed-files.txt"

# Build analysis tasks: one per (file, agent) pair
TASK_FILE="$WORKDIR/tasks.txt"
> "$TASK_FILE"

for file in "${CHANGED_FILES[@]}"; do
  # Skip binary/non-reviewable files
  case "$file" in
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|*.jar|*.class|*.lock)
      continue ;;
  esac
  # Skip deleted files
  if [[ ! -f "$REPO_ROOT/$file" ]]; then
    continue
  fi
  for agent in "${AGENTS[@]}"; do
    echo "$file|$agent" >> "$TASK_FILE"
  done
done

TASK_COUNT=$(wc -l < "$TASK_FILE")
echo -e "   ${DIM}$TASK_COUNT tasks (${#CHANGED_FILES[@]} files × ${#AGENTS[@]} agents)${NC}"

# Extract per-file diffs
MERGE_BASE_SHA=$(cd "$REPO_ROOT" && git merge-base HEAD "$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo main)" 2>/dev/null || true)

mkdir -p "$WORKDIR/diffs"
for file in "${CHANGED_FILES[@]}"; do
  safe_name="${file//\//__}"
  if [[ -n "$MERGE_BASE_SHA" ]]; then
    git -C "$REPO_ROOT" diff "$MERGE_BASE_SHA"..HEAD -- "$file" > "$WORKDIR/diffs/$safe_name.diff" 2>/dev/null || true
  fi
done

run_analysis() {
  local task="$1"
  local file="${task%%|*}"
  local agent="${task##*|}"
  local safe_name="${file//\//__}"
  local output_file="$WORKDIR/raw/${safe_name}__${agent}.json"
  local log_file="$WORKDIR/logs/${safe_name}__${agent}.log"
  local start_ts
  start_ts=$(date +%s%3N)

  # Get file diff
  local diff_content=""
  local diff_file="$WORKDIR/diffs/${safe_name}.diff"
  if [[ -f "$diff_file" ]]; then
    diff_content=$(cat "$diff_file")
  fi

  # Skip if no diff (file unchanged)
  if [[ -z "$diff_content" ]]; then
    echo "[]" > "$output_file"
    return
  fi

  # Read agent instructions (strip YAML frontmatter)
  local agent_instructions=""
  local agent_md="$AI_REVIEW_HOME/agents/${agent}.agent.md"
  if [[ -f "$agent_md" ]]; then
    agent_instructions=$(awk '/^---/{n++; if(n==2){found=1; next}} found{print}' "$agent_md")
  fi

  # Get file content for context
  local file_content=""
  if [[ -f "$REPO_ROOT/$file" ]]; then
    file_content=$(head -300 "$REPO_ROOT/$file")
  fi

  local prompt
  prompt=$(cat <<PROMPT
${agent_instructions}

---
Now apply the above instructions to this specific diff.

FILE: ${file}

=== DIFF (changes to review) ===
${diff_content}

=== CURRENT FILE CONTENT (first 300 lines, for context) ===
${file_content}

=== OUTPUT REQUIREMENT ===
Return ONLY a valid JSON array. No markdown code fences, no explanation text, no preamble.
Start your response with [ and end with ].
The "agent" field must be exactly "${agent}".
The "file" field must be exactly "${file}".
Example of correct output format:
[{"file":"${file}","line":10,"agent":"${agent}","severity":"warning","category":"example","message":"issue description","suggestion":"how to fix"}]
PROMPT
)

  # Run copilot in silent mode (-s suppresses metadata output)
  local result
  result=$(copilot -p "$prompt" -s 2>"$log_file" || true)

  # Save debug output
  if [[ "$DEBUG" == "true" ]]; then
    {
      echo "=== AGENT: $agent | FILE: $file ==="
      echo "=== RAW OUTPUT ==="
      echo "$result"
      echo "=== STDERR LOG ==="
      cat "$log_file" 2>/dev/null || true
    } > "$WORKDIR/debug/${safe_name}__${agent}.txt"
  fi

  # Extract JSON array from response
  local json=""

  # Strategy 1: entire response is the JSON array
  if echo "$result" | jq -e 'if type == "array" then . else error end' > /dev/null 2>&1; then
    json="$result"
  fi

  # Strategy 2: find the JSON array within markdown/prose response
  if [[ -z "$json" ]]; then
    json=$(echo "$result" | python3 -c "
import sys, json, re
text = sys.stdin.read()
# Find all JSON array candidates
candidates = re.findall(r'\[[\s\S]*?\]', text)
for candidate in reversed(candidates):
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, list):
            print(candidate)
            break
    except:
        pass
" 2>/dev/null || true)
  fi

  # Fallback
  if [[ -z "$json" ]] || ! echo "$json" | jq empty 2>/dev/null; then
    json="[]"
    echo "WARN: ${agent}@${file} returned non-JSON, falling back to []" >> "$log_file"
  fi

  echo "$json" > "$output_file"

  local end_ts
  end_ts=$(date +%s%3N)
  local duration=$(( end_ts - start_ts ))
  local count
  count=$(echo "$json" | jq 'length' 2>/dev/null || echo "?")
  echo -e "   ✓ ${agent} → ${file} (${duration}ms, ${count} findings)" >&2
}

export -f run_analysis
export WORKDIR AI_REVIEW_HOME DEBUG DIM NC

# Run tasks in parallel
if command -v parallel &>/dev/null; then
  cat "$TASK_FILE" | parallel -j "$MAX_PARALLEL" --line-buffer run_analysis
else
  cat "$TASK_FILE" | xargs -P "$MAX_PARALLEL" -I {} bash -c 'run_analysis "$@"' _ {}
fi

echo -e "   ${DIM}Analysis complete.${NC}"

