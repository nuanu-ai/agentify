#!/usr/bin/env sh
set -eu

flag_file="${REGISTRATION_BUILD_FLAG_FILE:-/app/.registration-build-flag}"
auth_fingerprint_file="${SUPABASE_AUTH_BUILD_FINGERPRINT_FILE:-/app/.supabase-auth-build-fingerprint}"
: "${REGISTRATION_ENABLED:?REGISTRATION_ENABLED is required}"
test -r "$flag_file" || {
  echo "Registration build flag is missing." >&2
  exit 1
}
build_flag="$(tr -d '\r\n' <"$flag_file")"
if [ "$build_flag" != "$REGISTRATION_ENABLED" ]; then
  echo "Registration build/runtime flags do not match; refusing to start." >&2
  exit 1
fi
if [ "$REGISTRATION_ENABLED" = "true" ]; then
  : "${SUPABASE_AUTH_URL:?SUPABASE_AUTH_URL is required when registration is enabled}"
  : "${SUPABASE_AUTH_PUBLISHABLE_KEY:?SUPABASE_AUTH_PUBLISHABLE_KEY is required when registration is enabled}"
  : "${SUPABASE_AUTH_SERVICE_ROLE_KEY:?SUPABASE_AUTH_SERVICE_ROLE_KEY is required when registration is enabled}"
  : "${NEXT_PUBLIC_SUPABASE_AUTH_URL:?NEXT_PUBLIC_SUPABASE_AUTH_URL is required when registration is enabled}"
  : "${NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY:?NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY is required when registration is enabled}"
  [ "$SUPABASE_AUTH_URL" = "$NEXT_PUBLIC_SUPABASE_AUTH_URL" ] || {
    echo "Supabase Auth server/browser URLs do not match; refusing to start." >&2
    exit 1
  }
  [ "$SUPABASE_AUTH_PUBLISHABLE_KEY" = "$NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY" ] || {
    echo "Supabase Auth server/browser publishable keys do not match; refusing to start." >&2
    exit 1
  }
  test -r "$auth_fingerprint_file" || {
    echo "Supabase Auth build fingerprint is missing." >&2
    exit 1
  }
  build_auth_fingerprint="$(tr -d '\r\n' <"$auth_fingerprint_file")"
  runtime_auth_fingerprint="$(node -e "const {createHash}=require('node:crypto'); process.stdout.write(createHash('sha256').update(process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL+'\\0'+process.env.NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY).digest('hex'))")"
  [ "$build_auth_fingerprint" = "$runtime_auth_fingerprint" ] || {
    echo "Supabase Auth build/runtime projects do not match; refusing to start." >&2
    exit 1
  }
fi
exec "$@"
