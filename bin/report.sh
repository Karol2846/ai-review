#!/usr/bin/env bash
set -euo pipefail

# report.sh — Format findings as a colored terminal report
# Usage: report.sh <findings.json>

FINDINGS_FILE="$1"

RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'
WHITE='\033[0;37m'

severity_icon() {
  case "$1" in
    critical) printf "${RED}●${NC}" ;;
    warning)  printf "${YELLOW}●${NC}" ;;
    info)     printf "${CYAN}●${NC}" ;;
    *)        printf "○" ;;
  esac
}

severity_color() {
  case "$1" in
    critical) printf "${RED}" ;;
    warning)  printf "${YELLOW}" ;;
    info)     printf "${CYAN}" ;;
    *)        printf "${NC}" ;;
  esac
}

current_file=""

# Emit one line per finding: file<TAB>severity<TAB>agent<TAB>category<TAB>line<TAB>message<TAB>suggestion
jq -r '
  sort_by([.file, (if .severity == "critical" then 0 elif .severity == "warning" then 1 else 2 end), .line]) |
  .[] |
  [.file, .severity, .agent, .category, (.line|tostring), .message, (.suggestion // "")] | @tsv
' "$FINDINGS_FILE" | while IFS=$'\t' read -r file severity agent category line_num message suggestion; do

  # Print file header when file changes
  if [[ "$file" != "$current_file" ]]; then
    if [[ -n "$current_file" ]]; then
      echo ""
    fi
    echo -e "${BOLD}━━━ ${file} ━━━${NC}"
    echo ""
    current_file="$file"
  fi

  icon=$(severity_icon "$severity")
  color=$(severity_color "$severity")

  echo -e "  ${icon} ${color}${severity}${NC} ${DIM}[${agent}/${category}]${NC} ${WHITE}L${line_num}${NC}"
  echo -e "    ${message}"
  if [[ -n "$suggestion" ]]; then
    echo -e "    ${GREEN}→ ${suggestion}${NC}"
  fi
  echo ""
done

# Summary line
echo -e "${DIM}─────────────────────────────────────────${NC}"
TOTAL=$(jq 'length' "$FINDINGS_FILE")
FILES=$(jq '[.[].file] | unique | length' "$FINDINGS_FILE")
AGENTS_COUNT=$(jq '[.[].agent] | unique | length' "$FINDINGS_FILE")
echo -e "${DIM}${TOTAL} findings across ${FILES} files from ${AGENTS_COUNT} agents${NC}"
