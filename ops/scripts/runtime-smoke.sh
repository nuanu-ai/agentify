#!/usr/bin/env bash
set -euo pipefail

WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:3000}"
WORKER_BASE_URL="${WORKER_BASE_URL:-}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

check_200() {
  local path="$1"
  local body="$tmp/$(echo "$path" | tr '/?' '__').body"
  local status
  status="$(curl --silent --show-error --max-time 20 --location --output "$body" --write-out '%{http_code}' "$WEB_BASE_URL$path")"
  [[ "$status" == "200" ]] || { echo "$path returned $status" >&2; exit 1; }
  if rg -n 'fonts\.googleapis\.com|fonts\.gstatic\.com|>Log in<' "$body"; then
    echo "$path contains forbidden runtime content" >&2
    exit 1
  fi
}

check_private_headers() {
  local url="$1"
  local label="$2"
  local headers
  headers="$(curl --silent --show-error --max-time 20 --head "$url")"
  grep -qi '^cache-control:.*private.*no-store' <<<"$headers" || {
    echo "$label missing private no-store" >&2
    exit 1
  }
  grep -qi '^referrer-policy: no-referrer' <<<"$headers" || {
    echo "$label missing no-referrer" >&2
    exit 1
  }
  grep -qi '^x-robots-tag: noindex, nofollow' <<<"$headers" || {
    echo "$label missing noindex" >&2
    exit 1
  }
}

check_asset() {
  local path="$1"
  local expected_type="$2"
  local headers="$tmp/$(echo "$path" | tr '/?' '__').headers"
  local body="$tmp/$(echo "$path" | tr '/?' '__').asset"
  local status
  status="$(curl --silent --show-error --max-time 20 --location --dump-header "$headers" --output "$body" --write-out '%{http_code}' "$WEB_BASE_URL$path")"
  [[ "$status" == "200" ]] || { echo "$path returned $status" >&2; exit 1; }
  grep -qi "^content-type: *$expected_type" "$headers" || {
    echo "$path did not return $expected_type" >&2
    exit 1
  }
  [[ -s "$body" ]] || { echo "$path returned an empty body" >&2; exit 1; }
}

for path in / /store /owner /local /scanner /methodology /privacy /terms /data-request /agentic-shop /agentic-shop/privacy; do
  check_200 "$path"
done

robots="$(curl --silent --show-error --fail --max-time 20 "$WEB_BASE_URL/robots.txt")"
grep -q '^Sitemap: https://agentify.ad/sitemap.xml$' <<<"$robots" || {
  echo "robots.txt is missing the canonical sitemap" >&2
  exit 1
}
grep -q '^Content-Signal: search=yes, ai-input=yes, ai-train=no$' <<<"$robots" || {
  echo "robots.txt has the wrong Content-Signal policy" >&2
  exit 1
}
for token in OAI-SearchBot ChatGPT-User GPTBot ClaudeBot Claude-User PerplexityBot Google-Extended; do
  grep -q "^User-agent: $token$" <<<"$robots" || {
    echo "robots.txt is missing $token" >&2
    exit 1
  }
done

sitemap="$(curl --silent --show-error --fail --max-time 20 "$WEB_BASE_URL/sitemap.xml")"
[[ "$(grep -o '<loc>' <<<"$sitemap" | wc -l | tr -d ' ')" == "8" ]] || {
  echo "sitemap.xml does not contain eight canonical URLs" >&2
  exit 1
}
for path in / /store /local /methodology /scanner /privacy /terms /agentic-shop; do
  grep -q "<loc>https://agentify.ad$path</loc>" <<<"$sitemap" || {
    echo "sitemap.xml is missing $path" >&2
    exit 1
  }
done

llms="$(curl --silent --show-error --fail --max-time 20 "$WEB_BASE_URL/llms.txt")"
grep -q '^# Agentify$' <<<"$llms" || { echo "llms.txt is missing its H1" >&2; exit 1; }
grep -Eq '\[[^]]+\]\(https://agentify\.ad/[^)]+\)' <<<"$llms" || {
  echo "llms.txt is missing absolute public links" >&2
  exit 1
}

front_html="$(curl --silent --show-error --fail --max-time 20 "$WEB_BASE_URL/")"
grep -q 'application/ld+json' <<<"$front_html" || {
  echo "/ is missing JSON-LD" >&2
  exit 1
}
grep -q '"@type":"Organization"' <<<"$front_html" || {
  echo "/ is missing Organization JSON-LD" >&2
  exit 1
}
data_request_html="$(curl --silent --show-error --fail --max-time 20 "$WEB_BASE_URL/data-request")"
if grep -q 'application/ld+json' <<<"$data_request_html"; then
  echo "/data-request unexpectedly contains public JSON-LD" >&2
  exit 1
fi

markdown_headers="$tmp/front-markdown.headers"
markdown_body="$tmp/front-markdown.body"
curl --silent --show-error --fail --max-time 20 \
  --header 'Accept: text/markdown' \
  --dump-header "$markdown_headers" --output "$markdown_body" \
  "$WEB_BASE_URL/"
grep -qi '^content-type: *text/markdown' "$markdown_headers" || {
  echo "/ Markdown has the wrong content type" >&2
  exit 1
}
grep -qi '^vary:.*accept' "$markdown_headers" || {
  echo "/ Markdown is missing Vary: Accept" >&2
  exit 1
}
grep -q '^# ' "$markdown_body" || { echo "/ Markdown is empty" >&2; exit 1; }

html_headers="$tmp/front-html.headers"
curl --silent --show-error --fail --max-time 20 \
  --header 'Accept: text/markdown;q=0, text/html' \
  --dump-header "$html_headers" --output /dev/null "$WEB_BASE_URL/"
grep -qi '^content-type: *text/html' "$html_headers" || {
  echo "/ returned Markdown when q=0" >&2
  exit 1
}
grep -qi '^vary:.*accept' "$html_headers" || {
  echo "/ HTML is missing Vary: Accept" >&2
  exit 1
}

for ua in 'ChatGPT-User/1.0' 'OAI-SearchBot/1.0' 'Claude-User' 'PerplexityBot/1.0'; do
  status="$(curl --silent --show-error --max-time 20 --user-agent "$ua" --output /dev/null --write-out '%{http_code}' "$WEB_BASE_URL/")"
  [[ "$status" == "200" ]] || { echo "$ua received $status" >&2; exit 1; }
done

# The owner landing is the front page; its old address redirects there with a
# response no cache may keep, since a cached redirect in either direction loops.
front_headers="$(curl --silent --show-error --max-time 20 --head "$WEB_BASE_URL/")"
grep -q '^HTTP/.* 200 ' <<<"$front_headers" || { echo "front page is not a 200" >&2; exit 1; }
owner_headers="$(curl --silent --show-error --max-time 20 --head "$WEB_BASE_URL/owner")"
grep -q '^HTTP/.* 308 ' <<<"$owner_headers" || { echo "/owner is not a 308" >&2; exit 1; }
grep -qi '^location: /[[:space:]]*$' <<<"$owner_headers" || { echo "/owner target is not /" >&2; exit 1; }
grep -qi '^cache-control: .*no-store' <<<"$owner_headers" || { echo "/owner redirect may be cached" >&2; exit 1; }

check_asset "/icon.svg" "image/svg+xml"
check_asset "/apple-icon" "image/png"
check_asset "/manifest.webmanifest" "application/manifest+json"
check_asset "/opengraph-image" "image/png"

icon_body="$tmp/_icon.svg.asset"
grep -q 'M50 40 H40 A6 6 0 0 0 34 46 V82 A6 6 0 0 0 40 88 H50' "$icon_body" || {
  echo "favicon is not the Agentify read-frame mark" >&2
  exit 1
}

health="$(curl --silent --show-error --fail --max-time 20 "$WEB_BASE_URL/api/health")"
[[ "$health" == *'"status":"ok"'* && "$health" == *'"rubric_version":"gtm-v1.0.0"'* ]] || {
  echo "web health payload is invalid" >&2
  exit 1
}
for dependency in database scanner_worker worker_heartbeat worker_database worker_queue scanner_capacity analytics_outbox; do
  [[ "$health" == *"\"$dependency\":\"ok\""* ]] || {
    echo "web health dependency $dependency is not healthy" >&2
    exit 1
  }
done

check_private_headers "$WEB_BASE_URL/auth/callback" "auth callback"

if [[ -n "$WORKER_BASE_URL" ]]; then
  curl --silent --show-error --fail --max-time 20 "$WORKER_BASE_URL/health/live" >/dev/null
  ready="$(curl --silent --show-error --fail --max-time 20 "$WORKER_BASE_URL/health/ready")"
  [[ "$ready" == *'"queue":true'* && "$ready" == *'"database":true'* ]] || {
    echo "worker readiness dependencies are not healthy" >&2
    exit 1
  }
fi

if [[ -n "${PRIVATE_SCAN_URL:-}" ]]; then
  check_private_headers "$PRIVATE_SCAN_URL" "private scan"
fi

echo "Runtime smoke passed for $WEB_BASE_URL${WORKER_BASE_URL:+ and $WORKER_BASE_URL}."
