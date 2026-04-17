#!/usr/bin/env bash
set -euo pipefail

# analyze.sh — Run reviewer agents against changed files
# Usage: analyze.sh <repo_root> <workdir> <agents_csv> <max_parallel> <ai_review_home> <debug> <strict> <batch_mode> <batch_max_chars> <max_file_kb> <include_large_files> <response_profile>

REPO_ROOT="$1"
WORKDIR="$2"
AGENTS_CSV="$3"
MAX_PARALLEL="$4"
AI_REVIEW_HOME="$5"
DEBUG="${6:-false}"
STRICT_MODE="${7:-false}"
BATCH_MODE="${8:-off}"
BATCH_MAX_CHARS="${9:-16000}"
MAX_FILE_KB="${10:-256}"
INCLUDE_LARGE_FILES="${11:-false}"
RESPONSE_PROFILE="${12:-full}"

PROMPT_VERSION="2026-04-token-opt-v1"
CONTEXT_WINDOW="${AI_REVIEW_CONTEXT_WINDOW:-25}"
CACHE_DIR="${AI_REVIEW_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/ai-review}"

# Ensure copilot subprocess can authenticate.
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
mkdir -p "$WORKDIR/raw" "$WORKDIR/logs" "$WORKDIR/diffs" "$WORKDIR/review-diffs" "$WORKDIR/contexts" "$WORKDIR/meta" "$WORKDIR/metrics/tasks" "$WORKDIR/agent-files" "$CACHE_DIR"
[[ "$DEBUG" == "true" ]] && mkdir -p "$WORKDIR/debug"

compact_agent_instructions() {
  local agent="$1"
  case "$agent" in
    clean-coder)
      cat <<'TXT'
Focus only on clean-code issues in changed lines: SRP, long/complex methods, naming, duplication, dead code, primitive obsession, magic values, exception handling.
Output JSON array only with fields: file,line,agent,severity,category,message,suggestion.
TXT
      ;;
    tester)
      cat <<'TXT'
Focus only on test adequacy for changed behavior: missing tests, uncovered error paths, edge cases, weak assertions, integration gaps.
Output JSON array only with fields: file,line,agent,severity,category,message,suggestion.
TXT
      ;;
    architect)
      cat <<'TXT'
Focus only on architecture risks: exception handling contract, HTTP status/error contracts, layer violations, coupling, event idempotency, hardcoded config.
Output JSON array only with fields: file,line,agent,severity,category,message,suggestion.
TXT
      ;;
    ddd-reviewer)
      cat <<'TXT'
Focus only on DDD issues: anemic domain model, aggregate boundaries, missing value objects, missing domain events, ubiquitous language.
Output JSON array only with fields: file,line,agent,severity,category,message,suggestion.
TXT
      ;;
    performance)
      cat <<'TXT'
Focus only on performance risks: N+1, unbounded queries, missing pagination, save-in-loop, blocking listeners, resource leaks, over-fetching.
Output JSON array only with fields: file,line,agent,severity,category,message,suggestion.
TXT
      ;;
    *)
      echo "Output JSON array only with fields: file,line,agent,severity,category,message,suggestion." ;;
  esac
}

safe_name_for_file() {
  local file="$1"
  local safe="${file//\//__}"
  echo "${safe// /_}"
}

extract_review_diff() {
  local diff_file="$1"
  python3 - "$diff_file" <<'PYEOF'
import re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8', errors='ignore').read()
lines = text.splitlines()
out = []
i = 0
while i < len(lines):
    line = lines[i]
    if line.startswith('diff --git ') or line.startswith('index ') or line.startswith('--- ') or line.startswith('+++ '):
        out.append(line)
        i += 1
        continue
    if line.startswith('@@ '):
        hunk_header = line
        hunk = []
        i += 1
        has_add = False
        while i < len(lines) and not lines[i].startswith('@@ ') and not lines[i].startswith('diff --git '):
            cur = lines[i]
            hunk.append(cur)
            if cur.startswith('+') and not cur.startswith('+++'):
                has_add = True
            i += 1
        if has_add:
            out.append(hunk_header)
            out.extend(hunk)
        continue
    i += 1
print('\n'.join(out))
PYEOF
}

extract_context_windows() {
  local file_path="$1"
  local diff_file="$2"
  local window="$3"
  python3 - "$file_path" "$diff_file" "$window" <<'PYEOF'
import re, sys
file_path, diff_path, window = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    file_lines = open(file_path, encoding='utf-8', errors='ignore').read().splitlines()
except Exception:
    print('')
    sys.exit(0)
diff_lines = open(diff_path, encoding='utf-8', errors='ignore').read().splitlines()
ranges = []
for ln in diff_lines:
    if ln.startswith('@@ '):
        m = re.search(r'\+(\d+)(?:,(\d+))?', ln)
        if m:
            start = int(m.group(1))
            count = int(m.group(2) or '1')
            if count <= 0:
                continue
            s = max(1, start - window)
            e = min(len(file_lines), start + count - 1 + window)
            ranges.append([s, e])
if not ranges:
    print('')
    sys.exit(0)
ranges.sort()
merged = []
for s, e in ranges:
    if not merged or s > merged[-1][1] + 1:
        merged.append([s, e])
    else:
        merged[-1][1] = max(merged[-1][1], e)
out = []
for s, e in merged:
    out.append(f'@@ CONTEXT {s}-{e} @@')
    for i in range(s, e + 1):
        out.append(f'{i:>6}: {file_lines[i-1]}')
print('\n'.join(out))
PYEOF
}

is_trivial_diff() {
  local diff_file="$1"
  python3 - "$diff_file" <<'PYEOF'
import re, sys
text = open(sys.argv[1], encoding='utf-8', errors='ignore').read().splitlines()
meaningful = 0
for ln in text:
    if not ln:
        continue
    if ln.startswith('+++') or ln.startswith('---') or ln.startswith('@@') or ln.startswith('diff --git') or ln.startswith('index '):
        continue
    if not (ln.startswith('+') or ln.startswith('-')):
        continue
    s = ln[1:].strip()
    if not s:
        continue
    if re.match(r'^(import|package|using)\b', s):
        continue
    if re.match(r'^[{}();,\[\]]+$', s):
        continue
    if re.match(r'^(//|#|/\*|\*|\*/)', s):
        continue
    meaningful += 1
print('true' if meaningful == 0 else 'false')
PYEOF
}

is_low_value_file() {
  local file="$1"
  case "$file" in
    */.git/*|*/node_modules/*|*/vendor/*|*/dist/*|*/build/*|*/target/*|*/coverage/*|*/.next/*|*/out/*)
      return 0 ;;
    *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff|*.woff2|*.ttf|*.eot|*.jar|*.class|*.lock|*.map|*.min.js|*.min.css|*.snap|*.pdf)
      return 0 ;;
    *.md|*.txt)
      return 0 ;;
  esac
  return 1
}

is_test_file() {
  local file="$1"
  [[ "$file" == *"/test/"* || "$file" == *"/tests/"* || "$file" == *"Test."* || "$file" == *"Spec."* || "$file" == *".spec."* || "$file" == *".test."* ]]
}

should_include_agent() {
  local agent="$1"
  local file="$2"
  local ext="$3"
  local trivial="$4"

  if [[ "$STRICT_MODE" == "true" ]]; then
    return 0
  fi

  if [[ "$trivial" == "true" ]]; then
    [[ "$agent" == "clean-coder" ]]
    return
  fi

  local source_like=false
  case "$ext" in
    java|kt|kts|groovy|scala|js|jsx|ts|tsx|go|py|rb|php|cs|cpp|c|h|hpp|swift|rs|sql|sh)
      source_like=true ;;
  esac

  local backend_like=false
  case "$ext" in
    java|kt|kts|groovy|scala|sql|yml|yaml|properties|tf|go|py)
      backend_like=true ;;
  esac

  local domain_like=false
  case "$ext" in
    java|kt|kts|groovy)
      domain_like=true ;;
  esac

  case "$agent" in
    clean-coder)
      $source_like
      ;;
    tester)
      $source_like
      ;;
    architect)
      $backend_like
      ;;
    ddd-reviewer)
      if ! $domain_like; then
        return 1
      fi
      if is_test_file "$file"; then
        return 1
      fi
      return 0
      ;;
    performance)
      if ! $backend_like; then
        return 1
      fi
      if is_test_file "$file"; then
        return 1
      fi
      return 0
      ;;
    *)
      return 0 ;;
  esac
}

build_prompt_single() {
  local agent="$1"
  local file="$2"
  local review_diff_file="$3"
  local context_file="$4"

  local compact
  compact="$(compact_agent_instructions "$agent")"

  local extra_rules=""
  if [[ "$RESPONSE_PROFILE" == "critical-warning" ]]; then
    extra_rules="Return only critical/warning findings, max 10 findings for this file."
  else
    extra_rules="Max 15 findings for this file."
  fi

  cat <<PROMPT
${compact}

Review file: ${file}
Agent: ${agent}
Prompt version: ${PROMPT_VERSION}

Diff hunks (added/modified focus):
$(cat "$review_diff_file")

Targeted context around changed lines:
$(cat "$context_file")

Output contract:
- Return ONLY a valid JSON array.
- No markdown, no explanation, no code fences.
- Each item must include: file,line,agent,severity,category,message,suggestion.
- "file" must equal "${file}".
- "agent" must equal "${agent}".
- ${extra_rules}
PROMPT
}

sanitize_and_limit_json() {
  local json_in="$1"
  local file="$2"
  local agent="$3"
  local tmp_filter='[ .[] | if type=="object" then . else empty end | .file = $file | .agent = $agent | .line = ((.line // 1) | tonumber? // 1) | .severity = (.severity // "info") | .category = (.category // "general") | .message = (.message // "") | .suggestion = (.suggestion // "") ]'

  if [[ "$RESPONSE_PROFILE" == "critical-warning" ]]; then
    echo "$json_in" | jq --arg file "$file" --arg agent "$agent" "$tmp_filter | map(select(.severity == \"critical\" or .severity == \"warning\")) | .[:10]"
  else
    echo "$json_in" | jq --arg file "$file" --arg agent "$agent" "$tmp_filter | .[:15]"
  fi
}

extract_json_from_result() {
  local result="$1"
  local json=""
  if echo "$result" | jq -e 'if type == "array" then . else error end' > /dev/null 2>&1; then
    json="$result"
  else
    json=$(echo "$result" | python3 -c "
import sys, json, re
text = sys.stdin.read()
candidates = re.findall(r'\[[\s\S]*?\]', text)
for candidate in reversed(candidates):
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, list):
            print(candidate)
            break
    except Exception:
        pass
" 2>/dev/null || true)
  fi

  if [[ -z "$json" ]] || ! echo "$json" | jq empty 2>/dev/null; then
    echo "[]"
  else
    echo "$json"
  fi
}

write_task_metric() {
  local file="$1"
  local agent="$2"
  local call_id="$3"
  local prompt_chars="$4"
  local duration_ms="$5"
  local findings_count="$6"
  local cache_hit="$7"
  local safe
  safe="$(safe_name_for_file "$file")"
  cat > "$WORKDIR/metrics/tasks/${safe}__${agent}.json" <<JSON
{"file":"$file","agent":"$agent","call_id":"$call_id","prompt_chars":$prompt_chars,"duration_ms":$duration_ms,"findings_count":$findings_count,"cache_hit":$cache_hit}
JSON
}

run_single_task() {
  local agent="$1"
  local file="$2"

  local safe
  safe="$(safe_name_for_file "$file")"
  local meta_file="$WORKDIR/meta/${safe}.json"
  local review_diff_file="$WORKDIR/review-diffs/${safe}.diff"
  local context_file="$WORKDIR/contexts/${safe}.txt"
  local output_file="$WORKDIR/raw/${safe}__${agent}.json"
  local log_file="$WORKDIR/logs/${safe}__${agent}.log"

  local diff_hash
  diff_hash=$(jq -r '.diff_hash' "$meta_file")
  local cache_key
  cache_key=$(printf "%s" "${agent}|${file}|${diff_hash}|${PROMPT_VERSION}|${RESPONSE_PROFILE}" | sha256sum | awk '{print $1}')
  local cache_file="$CACHE_DIR/${cache_key}.json"

  if [[ -f "$cache_file" ]]; then
    cp "$cache_file" "$output_file"
    local cached_count
    cached_count=$(jq 'length' "$output_file" 2>/dev/null || echo 0)
    write_task_metric "$file" "$agent" "" 0 0 "$cached_count" true
    echo -e "   ✓ ${agent} → ${file} (cache hit, ${cached_count} findings)" >&2
    return
  fi

  local prompt
  prompt="$(build_prompt_single "$agent" "$file" "$review_diff_file" "$context_file")"
  local prompt_chars=${#prompt}
  local start_ts
  start_ts=$(date +%s%3N)

  local result
  result=$(copilot -p "$prompt" -s 2>"$log_file" || true)

  if [[ "$DEBUG" == "true" ]]; then
    {
      echo "=== AGENT: $agent | FILE: $file ==="
      echo "=== PROMPT CHARS: $prompt_chars ==="
      echo "=== RAW OUTPUT ==="
      echo "$result"
      echo "=== STDERR LOG ==="
      cat "$log_file" 2>/dev/null || true
    } > "$WORKDIR/debug/${safe}__${agent}.txt"
  fi

  local json_raw
  json_raw="$(extract_json_from_result "$result")"
  local json
  json="$(sanitize_and_limit_json "$json_raw" "$file" "$agent" 2>/dev/null || echo '[]')"
  if ! echo "$json" | jq empty >/dev/null 2>&1; then
    json="[]"
  fi

  echo "$json" > "$output_file"
  cp "$output_file" "$cache_file"

  local end_ts
  end_ts=$(date +%s%3N)
  local duration=$(( end_ts - start_ts ))
  local count
  count=$(jq 'length' "$output_file" 2>/dev/null || echo 0)
  local call_id
  call_id="single:${agent}:${safe}:${start_ts}"

  write_task_metric "$file" "$agent" "$call_id" "$prompt_chars" "$duration" "$count" false
  echo -e "   ✓ ${agent} → ${file} (${duration}ms, ${count} findings)" >&2
}

run_batch_task() {
  local agent="$1"
  local files_csv="$2"

  IFS=',' read -ra FILES <<< "$files_csv"
  local pending=()

  for file in "${FILES[@]}"; do
    [[ -n "$file" ]] || continue
    local safe
    safe="$(safe_name_for_file "$file")"
    local meta_file="$WORKDIR/meta/${safe}.json"
    local output_file="$WORKDIR/raw/${safe}__${agent}.json"
    local diff_hash
    diff_hash=$(jq -r '.diff_hash' "$meta_file")
    local cache_key
    cache_key=$(printf "%s" "${agent}|${file}|${diff_hash}|${PROMPT_VERSION}|${RESPONSE_PROFILE}" | sha256sum | awk '{print $1}')
    local cache_file="$CACHE_DIR/${cache_key}.json"

    if [[ -f "$cache_file" ]]; then
      cp "$cache_file" "$output_file"
      local cached_count
      cached_count=$(jq 'length' "$output_file" 2>/dev/null || echo 0)
      write_task_metric "$file" "$agent" "" 0 0 "$cached_count" true
      echo -e "   ✓ ${agent} → ${file} (cache hit, ${cached_count} findings)" >&2
    else
      pending+=("$file")
    fi
  done

  if [[ ${#pending[@]} -eq 0 ]]; then
    return
  fi

  local compact
  compact="$(compact_agent_instructions "$agent")"

  local payload_sections=""
  local files_list=""
  local file
  for file in "${pending[@]}"; do
    local safe
    safe="$(safe_name_for_file "$file")"
    local review_diff_file="$WORKDIR/review-diffs/${safe}.diff"
    local context_file="$WORKDIR/contexts/${safe}.txt"
    payload_sections+=$'\n'
    payload_sections+="=== FILE: ${file} ==="
    payload_sections+=$'\n'
    payload_sections+="DIFF:"
    payload_sections+=$'\n'
    payload_sections+="$(cat "$review_diff_file")"
    payload_sections+=$'\n'
    payload_sections+="CONTEXT:"
    payload_sections+=$'\n'
    payload_sections+="$(cat "$context_file")"
    payload_sections+=$'\n'
    files_list+="${file},"
  done

  local extra_rules=""
  if [[ "$RESPONSE_PROFILE" == "critical-warning" ]]; then
    extra_rules="Return only critical/warning findings and max 10 findings per file."
  else
    extra_rules="Return max 15 findings per file."
  fi

  local prompt
  prompt=$(cat <<PROMPT
${compact}

Agent: ${agent}
Prompt version: ${PROMPT_VERSION}
Review the following files in one response.

${payload_sections}

Output contract:
- Return ONLY one valid JSON array.
- No markdown, no explanation, no code fences.
- Every item must include: file,line,agent,severity,category,message,suggestion.
- file must be one of: ${files_list%,}
- agent must be exactly "${agent}"
- ${extra_rules}
PROMPT
)

  local prompt_chars=${#prompt}
  local start_ts
  start_ts=$(date +%s%3N)
  local call_id
  call_id="batch:${agent}:${start_ts}"

  local log_file="$WORKDIR/logs/batch__${agent}__${start_ts}.log"
  local result
  result=$(copilot -p "$prompt" -s 2>"$log_file" || true)

  local json_raw
  json_raw="$(extract_json_from_result "$result")"
  if ! echo "$json_raw" | jq empty >/dev/null 2>&1; then
    json_raw='[]'
  fi

  local end_ts
  end_ts=$(date +%s%3N)
  local duration=$(( end_ts - start_ts ))

  if [[ "$DEBUG" == "true" ]]; then
    {
      echo "=== AGENT BATCH: $agent ==="
      echo "=== FILES: ${pending[*]} ==="
      echo "=== PROMPT CHARS: $prompt_chars ==="
      echo "=== RAW OUTPUT ==="
      echo "$result"
      echo "=== STDERR LOG ==="
      cat "$log_file" 2>/dev/null || true
    } > "$WORKDIR/debug/batch__${agent}__${start_ts}.txt"
  fi

  for file in "${pending[@]}"; do
    local safe
    safe="$(safe_name_for_file "$file")"
    local output_file="$WORKDIR/raw/${safe}__${agent}.json"
    local filtered
    filtered=$(echo "$json_raw" | jq --arg f "$file" '[.[] | select(.file == $f)]' 2>/dev/null || echo '[]')
    local sanitized
    sanitized="$(sanitize_and_limit_json "$filtered" "$file" "$agent" 2>/dev/null || echo '[]')"
    if ! echo "$sanitized" | jq empty >/dev/null 2>&1; then
      sanitized='[]'
    fi
    echo "$sanitized" > "$output_file"

    local meta_file="$WORKDIR/meta/${safe}.json"
    local diff_hash
    diff_hash=$(jq -r '.diff_hash' "$meta_file")
    local cache_key
    cache_key=$(printf "%s" "${agent}|${file}|${diff_hash}|${PROMPT_VERSION}|${RESPONSE_PROFILE}" | sha256sum | awk '{print $1}')
    cp "$output_file" "$CACHE_DIR/${cache_key}.json"

    local count
    count=$(jq 'length' "$output_file" 2>/dev/null || echo 0)
    write_task_metric "$file" "$agent" "$call_id" "$prompt_chars" "$duration" "$count" false
    echo -e "   ✓ ${agent} → ${file} (batch ${duration}ms, ${count} findings)" >&2
  done
}

build_metrics_summary() {
  local run_start_ms="$1"
  local run_end_ms="$2"
  local skipped_low_value="$3"
  local skipped_deleted="$4"
  local skipped_no_diff="$5"
  local skipped_large="$6"
  local skipped_no_agent="$7"

  local metrics_tmp="$WORKDIR/metrics/tasks-merged.json"
  if compgen -G "$WORKDIR/metrics/tasks/*.json" > /dev/null; then
    jq -s '.' "$WORKDIR/metrics/tasks/"*.json > "$metrics_tmp"
  else
    echo '[]' > "$metrics_tmp"
  fi

  jq --argjson runtime_ms "$((run_end_ms - run_start_ms))" \
     --arg prompt_version "$PROMPT_VERSION" \
     --arg strict_mode "$STRICT_MODE" \
     --arg batch_mode "$BATCH_MODE" \
     --arg response_profile "$RESPONSE_PROFILE" \
     --argjson skipped_low_value "$skipped_low_value" \
     --argjson skipped_deleted "$skipped_deleted" \
     --argjson skipped_no_diff "$skipped_no_diff" \
     --argjson skipped_large "$skipped_large" \
     --argjson skipped_no_agent "$skipped_no_agent" '
  def calls: [ .[] | select(.call_id != null and .call_id != "") ] | group_by(.call_id) | map(.[0]);
  {
    prompt_version: $prompt_version,
    strict_mode: ($strict_mode == "true"),
    batch_mode: $batch_mode,
    response_profile: $response_profile,
    runtime_ms: $runtime_ms,
    total_tasks: length,
    copilot_calls: (calls | length),
    cache_hits: ([ .[] | select(.cache_hit == true) ] | length),
    total_prompt_chars: (calls | map(.prompt_chars) | add // 0),
    avg_prompt_chars: (if (calls | length) > 0 then ((calls | map(.prompt_chars) | add) / (calls | length)) else 0 end),
    findings_count: (map(.findings_count) | add // 0),
    skipped: {
      low_value: $skipped_low_value,
      deleted: $skipped_deleted,
      no_diff: $skipped_no_diff,
      large_file: $skipped_large,
      no_routed_agents: $skipped_no_agent
    }
  }
  ' "$metrics_tmp" > "$WORKDIR/metrics/analyze.json"
}

CHANGED_FILES=()
while IFS= read -r line; do
  CHANGED_FILES+=("$line")
done < "$WORKDIR/changed-files.txt"

MERGE_BASE_SHA=$(cd "$REPO_ROOT" && git merge-base HEAD "$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo main)" 2>/dev/null || true)

TASK_FILE="$WORKDIR/tasks.txt"
> "$TASK_FILE"

skipped_low_value=0
skipped_deleted=0
skipped_no_diff=0
skipped_large=0
skipped_no_agent=0

for file in "${CHANGED_FILES[@]}"; do
  if [[ ! -f "$REPO_ROOT/$file" ]]; then
    skipped_deleted=$((skipped_deleted + 1))
    continue
  fi

  if is_low_value_file "$file"; then
    skipped_low_value=$((skipped_low_value + 1))
    continue
  fi

  if [[ "$INCLUDE_LARGE_FILES" != "true" ]]; then
    file_size_kb=$(du -k "$REPO_ROOT/$file" | awk '{print $1}')
    if (( file_size_kb > MAX_FILE_KB )); then
      skipped_large=$((skipped_large + 1))
      continue
    fi
  fi

  safe_name="$(safe_name_for_file "$file")"
  diff_file="$WORKDIR/diffs/$safe_name.diff"
  if [[ -n "$MERGE_BASE_SHA" ]]; then
    git -C "$REPO_ROOT" diff "$MERGE_BASE_SHA"..HEAD -- "$file" > "$diff_file" 2>/dev/null || true
  else
    git -C "$REPO_ROOT" diff HEAD~1..HEAD -- "$file" > "$diff_file" 2>/dev/null || true
  fi

  if [[ ! -s "$diff_file" ]]; then
    skipped_no_diff=$((skipped_no_diff + 1))
    continue
  fi

  review_diff_file="$WORKDIR/review-diffs/$safe_name.diff"
  extract_review_diff "$diff_file" > "$review_diff_file"
  if [[ ! -s "$review_diff_file" ]]; then
    cp "$diff_file" "$review_diff_file"
  fi

  context_file="$WORKDIR/contexts/$safe_name.txt"
  extract_context_windows "$REPO_ROOT/$file" "$diff_file" "$CONTEXT_WINDOW" > "$context_file"

  trivial="$(is_trivial_diff "$diff_file")"
  ext="${file##*.}"
  ext="${ext,,}"
  diff_hash="$(sha256sum "$review_diff_file" | awk '{print $1}')"
  review_diff_chars=$(wc -c < "$review_diff_file")
  context_chars=$(wc -c < "$context_file")

  cat > "$WORKDIR/meta/${safe_name}.json" <<JSON
{"file":"$file","safe":"$safe_name","trivial":$trivial,"ext":"$ext","diff_hash":"$diff_hash","review_diff_chars":$review_diff_chars,"context_chars":$context_chars}
JSON

  routed=0
  for agent in "${AGENTS[@]}"; do
    if should_include_agent "$agent" "$file" "$ext" "$trivial"; then
      echo "$file" >> "$WORKDIR/agent-files/${agent}.txt"
      routed=1
      if [[ "$BATCH_MODE" == "agent" ]]; then
        :
      else
        echo "single|$agent|$file" >> "$TASK_FILE"
      fi
    fi
  done

  if [[ "$routed" -eq 0 ]]; then
    skipped_no_agent=$((skipped_no_agent + 1))
  fi
done

if [[ "$BATCH_MODE" == "agent" ]]; then
  for agent in "${AGENTS[@]}"; do
    list_file="$WORKDIR/agent-files/${agent}.txt"
    [[ -f "$list_file" ]] || continue

    batch_files=()
    batch_chars=0
    while IFS= read -r file; do
      [[ -n "$file" ]] || continue
      safe_name="$(safe_name_for_file "$file")"
      est_chars=$(jq -r '(.review_diff_chars + .context_chars + 500)' "$WORKDIR/meta/${safe_name}.json")
      if (( ${#batch_files[@]} > 0 && batch_chars + est_chars > BATCH_MAX_CHARS )); then
        echo "batch|$agent|$(IFS=,; echo "${batch_files[*]}")" >> "$TASK_FILE"
        batch_files=()
        batch_chars=0
      fi
      batch_files+=("$file")
      batch_chars=$((batch_chars + est_chars))
    done < "$list_file"

    if (( ${#batch_files[@]} > 0 )); then
      echo "batch|$agent|$(IFS=,; echo "${batch_files[*]}")" >> "$TASK_FILE"
    fi
  done
fi

TASK_COUNT=$(wc -l < "$TASK_FILE" | tr -d ' ')
echo -e "   ${DIM}$TASK_COUNT Copilot calls planned (${#CHANGED_FILES[@]} changed files)${NC}"

run_task() {
  local task="$1"
  local kind="${task%%|*}"
  local rest="${task#*|}"
  local agent="${rest%%|*}"
  local payload="${rest#*|}"

  if [[ "$kind" == "single" ]]; then
    run_single_task "$agent" "$payload"
  else
    run_batch_task "$agent" "$payload"
  fi
}

export -f compact_agent_instructions safe_name_for_file extract_review_diff extract_context_windows is_trivial_diff is_low_value_file is_test_file should_include_agent build_prompt_single sanitize_and_limit_json extract_json_from_result write_task_metric run_single_task run_batch_task run_task
export REPO_ROOT WORKDIR AI_REVIEW_HOME DEBUG DIM NC PROMPT_VERSION CONTEXT_WINDOW CACHE_DIR RESPONSE_PROFILE STRICT_MODE BATCH_MODE BATCH_MAX_CHARS MAX_FILE_KB INCLUDE_LARGE_FILES

run_start_ms=$(date +%s%3N)

if [[ "$TASK_COUNT" -gt 0 ]]; then
  if command -v parallel &>/dev/null; then
    cat "$TASK_FILE" | parallel -j "$MAX_PARALLEL" --line-buffer run_task
  else
    cat "$TASK_FILE" | xargs -P "$MAX_PARALLEL" -I {} bash -c 'run_task "$@"' _ {}
  fi
fi

run_end_ms=$(date +%s%3N)
build_metrics_summary "$run_start_ms" "$run_end_ms" "$skipped_low_value" "$skipped_deleted" "$skipped_no_diff" "$skipped_large" "$skipped_no_agent"

echo -e "   ${DIM}Analysis complete.${NC}"
