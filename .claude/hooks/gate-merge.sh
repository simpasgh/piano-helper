#!/usr/bin/env bash
# PreToolUse(Bash) gate: block direct pushes and force-merges into main.
# Work must ship through the gated flow (feature branch -> PR -> CI -> squash/rebase merge).
# Reads the hook payload as JSON on stdin; denies by emitting a permissionDecision.
# No jq/python dependency: we grep the raw payload so the hook stays portable.
set -euo pipefail

payload="$(cat || true)"

# Pull out the command string. Fall back to the whole payload if extraction fails;
# grepping the raw JSON is good enough to catch the dangerous patterns.
cmd="$payload"

deny() {
  # Escape for JSON: backslashes and double quotes.
  reason="$1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
    "\"$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
  exit 0
}

# Direct push to main (e.g. `git push origin main`, `git push --force ... main`).
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push([[:space:]]+[^"]*)?[[:space:]]+(origin[[:space:]]+)?(HEAD:)?(refs/heads/)?main(\b|")'; then
  deny "Direct push to main is blocked by the merge gate. Ship via the gated flow: work on a feat/|fix/|chore/ branch, open a PR, let CI pass, then merge with --squash or --rebase. See docs/workflow.md or run /release."
fi

# Force-push anywhere is destructive to shared history.
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push[[:space:]]+[^"]*(--force\b|--force-with-lease\b|[[:space:]]-f\b)'; then
  deny "Force-push is blocked. It rewrites shared history and can clobber parallel work. If you truly need this, ask the user to run it manually."
fi

# Merge commit into main breaks the required linear history.
if printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+[^"]*--merge(\b|")'; then
  deny "Merge commits are blocked: the ruleset requires linear history. Use 'gh pr merge --squash' or '--rebase' instead."
fi

# Default: allow (exit 0 with no output lets the normal permission flow continue).
exit 0
