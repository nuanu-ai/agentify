#!/usr/bin/env bash
# SessionStart hook: tell the session when this checkout is behind origin.
#
# Written after 2026-09-28, when a five-thread security audit and a Claude
# session read a main checkout that was 534 commits behind origin/main and
# reported deleted files as live configuration. The hook only warns; it never
# pulls, because other sessions may be working in the same checkout.
set -u

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# macOS has no `timeout`; perl's alarm bounds the fetch so an offline machine
# does not hold the session start.
fetched=yes
{ perl -e 'alarm shift; exec @ARGV' 8 git fetch --quiet origin >/dev/null 2>&1; } 2>/dev/null || fetched=no

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "detached HEAD")"
behind_main="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
behind_upstream=0
if [ -n "$upstream" ] && [ "$upstream" != "origin/main" ]; then
  behind_upstream="$(git rev-list --count HEAD.."$upstream" 2>/dev/null || echo 0)"
fi

note=""
if [ "$behind_main" -gt 0 ] && [ "$branch" = "main" ]; then
  note="The main checkout is $behind_main commits behind origin/main. Files read here are not what origin/main holds: run \`git pull --ff-only\` before reading code or docs, or read with \`git show \"origin/main:<path>\"\`."
elif [ "$behind_main" -gt 0 ]; then
  note="Branch $branch is $behind_main commits behind origin/main. Code and docs outside this branch's own changes may be out of date; read \`git show \"origin/main:<path>\"\` before stating what main does today."
fi
if [ "$behind_upstream" -gt 0 ]; then
  note="${note:+$note }Branch $branch is also $behind_upstream commits behind its upstream $upstream."
fi
if [ -n "$note" ] && [ "$fetched" = no ]; then
  note="$note (origin could not be reached; this compares against the last fetched refs.)"
fi
[ -n "$note" ] || exit 0

jq -n --arg note "$note" '{
  systemMessage: $note,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $note }
}'
