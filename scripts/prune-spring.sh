#!/usr/bin/env bash
# prune-spring.sh — Kill stale Spring (Rails) processes
#
# A Spring process is considered stale if:
#   1. Its worktree directory no longer exists (primary check), OR
#   2. It has been running longer than MAX_HOURS (fallback, default: 24h)
#
# Usage:
#   ./scripts/prune-spring.sh              # dry-run, shows what would be killed
#   ./scripts/prune-spring.sh --kill       # actually kill stale processes
#   MAX_HOURS=48 ./scripts/prune-spring.sh --kill
#
# Environment variables:
#   SPRING_WORKTREES_DIR  Path to the directory containing worktrees (default: ~/.cyrus/worktrees)
#   MAX_HOURS             Kill processes older than this many hours (default: 24)

set -euo pipefail

WORKTREES_DIR="${SPRING_WORKTREES_DIR:-$HOME/.cyrus/worktrees}"
MAX_HOURS="${MAX_HOURS:-24}"
DRY_RUN=true

if [[ "${1:-}" == "--kill" ]]; then
  DRY_RUN=false
fi

killed=0
skipped=0

# Parse each spring process line.
# Spring processes include their project name and age in the command string, e.g.:
#   spring server | PC-8609 | started 33 mins ago
#   spring app    | PC-8609 | started 33 mins ago | test mode
while IFS= read -r line; do
  pid=$(awk '{print $2}' <<< "$line")
  cmd_col=$(awk '{for(i=11;i<=NF;i++) printf $i" "; print ""}' <<< "$line")

  # Extract worktree name (token after first "|")
  worktree=$(sed -n 's/.*spring [a-z]* *| *\([^ |]*\).*/\1/p' <<< "$cmd_col")

  # Extract age in hours ("409 hours ago" → 409; "33 mins ago" → 0)
  age_hours=0
  if grep -qP '\d+ hours? ago' <<< "$cmd_col"; then
    age_hours=$(grep -oP '\d+(?= hours? ago)' <<< "$cmd_col")
  fi

  stale=false
  reason=""

  # Check 1: worktree directory missing
  if [[ -n "$worktree" && ! -d "$WORKTREES_DIR/$worktree" ]]; then
    stale=true
    reason="worktree '$worktree' not found in $WORKTREES_DIR"
  fi

  # Check 2: age threshold
  if [[ "$stale" == false && "$age_hours" -gt "$MAX_HOURS" ]]; then
    stale=true
    reason="${age_hours}h old (threshold: ${MAX_HOURS}h)"
  fi

  if [[ "$stale" == true ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      echo "[DRY RUN] Would kill PID $pid ($worktree) — $reason"
    else
      if kill -9 "$pid" 2>/dev/null; then
        echo "Killed PID $pid ($worktree) — $reason"
        ((killed++)) || true
      else
        echo "Already gone: PID $pid ($worktree)"
      fi
    fi
  else
    ((skipped++)) || true
    echo "Keeping PID $pid ($worktree, ${age_hours}h old)"
  fi

done < <(ps aux | grep '[s]pring' | grep -v grep)

echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run complete. Run with --kill to terminate stale processes."
else
  echo "Done. Killed: $killed, Kept: $skipped"
fi
