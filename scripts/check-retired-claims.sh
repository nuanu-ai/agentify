#!/usr/bin/env bash
#
# Checks that sentences this repository has retired do not come back.
#
# A sentence earns a line here only after it was believed, written down and
# found to be false, and the line records what is true instead, so whoever
# trips it learns something rather than searching for a synonym. The search
# is case-insensitive over every tracked text file under apps/, packages/,
# docs/research/ and docs/decisions/; the decision records are searched too,
# because a corrected decision is edited in place.
#
# Not checked: synonyms, paraphrases or any style. This is a list of four
# sentences, not a style checker, and the behaviour behind each is held by
# the tests of the code that does it.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

retired_words=(
  "under the same envelope identifier"
  "share no field but the payload"
  "redelivery by visibility timeout"
  "if the refund has gone out"
)

true_instead=(
  "each attempt at an order is a fresh envelope with an identifier of its own; a handler recognises a repeat by the order's identifier inside the payload"
  "two attempts share their kind as well — the only thing they have in common that matters is the order they carry"
  "the queue's own retries are off; redelivery is decided by the order machine, and a drawn envelope is never re-offered"
  "late delivery remains possible on an unfulfilled paid order until the merchant closes Agentify fulfillment; any refund or other agreement remains between the merchant and buyer"
)

problems=0

for index in "${!retired_words[@]}"; do
  words="${retired_words[${index}]}"

  # git grep answers 1 when nothing matches and more than 1 when it could not
  # search at all; only the second is a failure of the check.
  grep_status=0
  found="$(
    git -C "${repository_root}" grep -n -I -i -F -e "${words}" \
      -- apps packages docs/research docs/decisions
  )" || grep_status=$?

  if [ "${grep_status}" -gt 1 ]; then
    printf 'Could not search the tracked files for retired sentences (git grep exit %s).\n' "${grep_status}" >&2
    exit 1
  fi

  if [ -n "${found}" ]; then
    while IFS= read -r line; do
      printf '%s: "%s" — %s\n' "${line}" "${words}" "${true_instead[${index}]}" >&2
      problems=$((problems + 1))
    done <<<"$(printf '%s\n' "${found}" | cut -d: -f1,2)"
  fi
done

if [ "${problems}" -ne 0 ]; then
  printf 'Retired sentences are back in the tree. Problems: %s.\n' "${problems}" >&2
  exit 1
fi

printf 'No retired sentence is back. Sentences checked: %s.\n' "${#retired_words[@]}"
