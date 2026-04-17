#!/usr/bin/env bash
set -euo pipefail

# annotate.sh — Insert/remove [ai-review] TODO comments in source files
# Usage: annotate.sh --apply <findings.json> <repo_root>
#        annotate.sh --clean <repo_root>

MODE="$1"
shift

GREEN='\033[0;32m'
DIM='\033[2m'
NC='\033[0m'

comment_prefix() {
  local file="$1"
  case "$file" in
    *.java|*.groovy|*.kt|*.scala|*.js|*.ts|*.tsx|*.jsx|*.go|*.rs|*.c|*.cpp|*.h)
      echo "//" ;;
    *.yml|*.yaml|*.properties|*.py|*.rb|*.sh|*.bash|*.toml|*.cfg|*.ini|*.tf)
      echo "#" ;;
    *.sql)
      echo "--" ;;
    *.xml|*.html|*.htm)
      echo "XML_COMMENT" ;;
    *)
      echo "SKIP" ;;
  esac
}

if [[ "$MODE" == "--clean" ]]; then
  REPO_ROOT="$1"
  echo -e "   ${DIM}Searching for [ai-review] comments...${NC}"

  # Find and remove lines containing [ai-review] marker
  count=0
  while IFS= read -r file; do
    if [[ -f "$file" ]]; then
      if grep -q '\[ai-review\]' "$file"; then
        grep -v '\[ai-review\]' "$file" > "${file}.tmp"
        mv "${file}.tmp" "$file"
        count=$((count + 1))
        echo -e "   ${DIM}✓ Cleaned: ${file#$REPO_ROOT/}${NC}"
      fi
    fi
  done < <(grep -rl '\[ai-review\]' "$REPO_ROOT" --include='*.java' --include='*.groovy' --include='*.kt' --include='*.yml' --include='*.yaml' --include='*.properties' --include='*.sql' --include='*.xml' --include='*.py' --include='*.sh' --include='*.tf' 2>/dev/null || true)

  echo -e "${GREEN}Cleaned $count files.${NC}"
  exit 0
fi

if [[ "$MODE" == "--apply" ]]; then
  FINDINGS_FILE="$1"
  REPO_ROOT="$2"

  # Process findings sorted by file and reverse line number (insert bottom-up to preserve line numbers)
  jq -r '
    sort_by([.file, -(.line // 0)]) |
    .[] |
    [.file, (.line|tostring), .agent, .severity, .message, .suggestion] | @tsv
  ' "$FINDINGS_FILE" | while IFS=$'\t' read -r file line agent severity message suggestion; do

    filepath="$REPO_ROOT/$file"
    if [[ ! -f "$filepath" ]]; then
      continue
    fi

    prefix=$(comment_prefix "$file")

    if [[ "$prefix" == "SKIP" ]]; then
      continue
    fi

    # Build comment text
    local_suggestion=""
    if [[ -n "$suggestion" ]]; then
      local_suggestion=" → $suggestion"
    fi

    if [[ "$prefix" == "XML_COMMENT" ]]; then
      comment="<!-- TODO $agent $severity: ${message}${local_suggestion} [ai-review] -->"
    else
      comment="$prefix TODO $agent $severity: ${message}${local_suggestion} [ai-review]"
    fi

    # Insert comment above the target line
    if [[ "$line" =~ ^[0-9]+$ ]] && [[ "$line" -ge 1 ]]; then
      # Get indentation of target line
      target_line=$(sed -n "${line}p" "$filepath")
      indent=$(echo "$target_line" | sed 's/[^ \t].*//')

      sed -i "${line}i\\${indent}${comment}" "$filepath"
      echo -e "   ${DIM}✓ L${line} ${agent}/${severity} → ${file}${NC}"
    fi
  done

  echo -e "${GREEN}Annotations applied.${NC}"
  exit 0
fi

echo "Usage: annotate.sh --apply <findings.json> <repo_root>"
echo "       annotate.sh --clean <repo_root>"
exit 1
