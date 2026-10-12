#!/usr/bin/env bash
#
# Does the SDK work for somebody who does not have this repository? The unit
# tests, the type checker and `pnpm test` all see the workspace, so each can
# pass on a package that dies on first use elsewhere. This packs the tarballs
# npm would publish, installs them into a directory with no path back here, and
# runs the two commands the quickstart tells a merchant to run.
#
# It needs the network (the install pulls zod from the registry), so it lives
# beside `pnpm smoke`, not inside `pnpm test`. `@nuanu-ai/agentify-contracts` is
# packed as well, because a merchant who installs the SDK installs both.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/agentify-outside.XXXXXX")"

failures=0

# A failing run leaves the install and the tarballs in place for debugging.
cleanup() {
  if [ "$failures" -eq 0 ]; then
    rm -rf "$scratch"
  else
    printf '\nLeft in place for reading: %s\n' "$scratch"
  fi
}
trap cleanup EXIT

# Report and keep going, so one run names everything that is wrong; the exit
# code at the bottom fails the command.
check() {
  local what="$1" expected="$2" actual="$3"

  if [ "$expected" = "$actual" ]; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n         expected: %s\n         actual:   %s\n' \
      "$what" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

contains() {
  local what="$1" needle="$2" haystack="$3"

  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf '  ok    %s\n' "$what"
  else
    printf '  FAIL  %s\n         no "%s" in what it said\n' "$what" "$needle"
    failures=$((failures + 1))
  fi
}

echo "Packing the two publishable packages the way a release would"
# The build output is deleted first: each package's `prepack` runs its own
# build, so a package that lost that hook packs an empty tarball here instead of
# a stale build.
rm -rf "$repo/packages/sdk/dist" "$repo/packages/contracts/dist"
# `pnpm pack` applies `publishConfig`, so these tarballs carry the built entry
# points and the command, and `workspace:*` becomes a real version range.
pnpm --filter @nuanu-ai/agentify-contracts exec pnpm pack --pack-destination "$scratch" >/dev/null
pnpm --filter @nuanu-ai/agentify exec pnpm pack --pack-destination "$scratch" >/dev/null
ls -1 "$scratch"

echo
echo "What the tarballs would ship"
# An allowlist: `dist`, the manifest and the legal notices are the whole
# surface, so anything else is the finding. Tests and the fake gateway are named
# as well, because they can only reach a merchant compiled into `dist`, which
# the allowlist alone would pass; nothing else pins the exclusions in
# tsconfig.build.json.
for tarball in "$scratch"/nuanu-ai-agentify-*.tgz; do
  unexpected="$(tar -tzf "$tarball" |
    grep -vE '^package/(package\.json|README\.md|LICENSE|NOTICE|dist/)' || true)"
  compiled_tests="$(tar -tzf "$tarball" | grep -E '\.test\.|/testing/' || true)"
  check "$(basename "$tarball") ships its build and nothing else" "" \
    "${unexpected}${compiled_tests}"
  contains "$(basename "$tarball") carries the Apache license" "Apache License" \
    "$(tar -xOzf "$tarball" package/LICENSE)"
  contains "$(basename "$tarball") attributes Nuanu AI" "Nuanu AI" \
    "$(tar -xOzf "$tarball" package/NOTICE)"
done

contains "the command is in it" "package/dist/cli.js" \
  "$(tar -tzf "$scratch"/nuanu-ai-agentify-[0-9]*.tgz)"

echo
echo "Installing the tarballs into $scratch"
# Outside the repository, Node's upward module resolution never reaches the
# workspace. npm, not pnpm, because the quickstart tells a merchant to use npm.
cd "$scratch"
cat > package.json <<'JSON'
{
  "name": "a-merchant-project",
  "version": "1.0.0",
  "type": "module",
  "private": true
}
JSON

npm install --no-audit --no-fund \
  ./nuanu-ai-agentify-contracts-*.tgz ./nuanu-ai-agentify-[0-9]*.tgz

# The declarations must stand on their own in a strict project, without the
# workspace's root `@types/node`. The SDK runs on Node 24's standard Web APIs
# (URL, fetch, AbortSignal), so the consumer declares that library while
# `types: []` excludes every ambient package.
cat > consumer.ts <<'TS'
import { createClient } from "@nuanu-ai/agentify";

const client = createClient({
  apiKey: "merchant_key_for_typechecking_only",
  baseUrl: "https://agentify.example",
});

void client;
TS

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "lib": ["es2024", "dom"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "noEmit": true,
    "skipLibCheck": false,
    "strict": true,
    "types": []
  },
  "include": ["consumer.ts"]
}
JSON

"$repo/node_modules/.bin/tsc" -p tsconfig.json

# The pilot's eSIM card.
cat > card.json <<'JSON'
{
  "merchant_item_id": "esim-eu-5gb-30d",
  "title": "eSIM, Europe, 5 GB, 30 days",
  "description": "A data-only eSIM for Europe: 5 GB, valid 30 days from first activation. Delivered as an activation code once the provider issues the profile.",
  "price": { "amount": "8.00", "currency": "USD" },
  "params": {
    "email": { "type": "string", "required": true, "title": "Where to send the activation code" }
  },
  "result": {
    "activation_code": { "type": "string", "title": "The eSIM activation code (an LPA string)" },
    "iccid": { "type": "string", "title": "The eSIM ICCID" }
  },
  "fulfillment": "async"
}
JSON

# The pilot's rented number, written the short way: the price as one string,
# the delivered field as its type word, no fulfillment mode. `params` stays
# written out, because a required parameter with a title has no shorter form.
#
# This is here rather than in the unit tests because the contracts package reads
# the short forms and the SDK holds the command: a version range that let an
# older contracts package answer would lose the short forms with every test in
# this repository still green.
cat > short-card.json <<'JSON'
{
  "merchant_item_id": "virtual-number-monthly-nl",
  "title": "Virtual phone number, the Netherlands, one month",
  "description": "A rented number for one month, incoming SMS only. Whether a given sender's one-time code arrives depends on that sender.",
  "price": "8.75 USD",
  "params": {
    "country": { "type": "string", "required": true, "title": "Country of the number" }
  },
  "result": { "phone_number": "string" }
}
JSON

# The negative control: without it, a command that always printed "complete"
# would pass.
node -e '
  const card = JSON.parse(require("fs").readFileSync("card.json", "utf8"));
  delete card.title;
  require("fs").writeFileSync("untitled-card.json", JSON.stringify(card, null, 2));
'

# The negative control for the short forms: a short price nobody could settle
# in must be refused, naming which half of it is wrong.
node -e '
  const card = JSON.parse(require("fs").readFileSync("short-card.json", "utf8"));
  card.price = "8.75 dollars";
  require("fs").writeFileSync("miswritten-card.json", JSON.stringify(card, null, 2));
'

echo
echo "Step 3 of the quickstart: importing the package"
# Plain `node`, with no loader or transpiler, as a merchant has it: the entry
# point must resolve, and its exports must be the working code, not an empty
# shape.
imported="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { checkCard, createClient, contractVersion } from "@nuanu-ai/agentify";
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const complete = checkCard(read("card.json")).problems.length === 0;
  const short = checkCard(read("short-card.json")).problems.length === 0;
  console.log(
    `contract=${contractVersion} client=${typeof createClient} complete=${complete} short=${short}`,
  );
' 2>&1)" || imported="node refused it: $imported"
echo "  $imported"
contains "the entry point imports and its exports are callable" \
  "client=function" "$imported"
contains "the check runs on a real card" "complete=true" "$imported"
contains "the check reads a card written short" "short=true" "$imported"

echo
echo "Step 4 of the quickstart: the installed Agentify command"

# The unscoped `agentify` package on the public registry belongs to somebody
# else. The local link is checked first, and the scoped, offline flags below
# keep npm from substituting it if this link is absent.
linked="$(readlink node_modules/.bin/agentify 2>&1 || true)"
check "npm will find our installed command and not a stranger's" \
  "../@nuanu-ai/agentify/dist/cli.js" "$linked"

run() {
  set +e
  out="$(npm exec --offline --package=@nuanu-ai/agentify -- agentify "$@" 2>&1)"
  code=$?
  set -e
}

run verify card.json
echo "--- agentify verify card.json (exit $code) ---"
echo "$out"
check "a complete card answers 0" "0" "$code"
contains "it says the card is complete" "complete as far as the contract can tell" "$out"
contains "it says what it does not check, and where that is proved" \
  "with a test purchase" "$out"

run verify short-card.json
echo "--- agentify verify short-card.json (exit $code) ---"
echo "$out"
check "a card written short answers 0, the same as one written out" "0" "$code"
contains "it says the short card is complete too" \
  "complete as far as the contract can tell" "$out"

run verify untitled-card.json
echo "--- agentify verify untitled-card.json (exit $code) ---"
echo "$out"
check "a card with a finding answers 1" "1" "$code"
contains "it names the field that is missing" "title:" "$out"

run verify miswritten-card.json
echo "--- agentify verify miswritten-card.json (exit $code) ---"
echo "$out"
check "a card whose short price is not one answers 1" "1" "$code"
contains "it names the half of the price that is wrong" "price.currency:" "$out"

run verify
echo "--- agentify verify (exit $code) ---"
echo "$out"
check "the bare command answers 2 and refuses" "2" "$code"
contains "it explains itself to whoever typed it" \
  "where you keep the cards you" "$out"

echo
if [ "$failures" -eq 0 ]; then
  echo "The package works outside this repository."
else
  echo "$failures check(s) failed: the package does not work outside this repository."
fi
exit "$failures"
