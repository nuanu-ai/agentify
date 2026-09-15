#!/usr/bin/env sh
set -eu

flag_file="${REGISTRATION_BUILD_FLAG_FILE:-/app/.registration-build-flag}"
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
  : "${APP_BASE_URL:?APP_BASE_URL is required when registration is enabled}"
  : "${DATABASE_URL:?DATABASE_URL is required when registration is enabled}"
  : "${TOKEN_HMAC_SECRET:?TOKEN_HMAC_SECRET is required when registration is enabled}"
  [ "${EMAIL_PROVIDER:-}" = "resend" ] || {
    echo "Enabled production registration requires the Resend production mail provider." >&2
    exit 1
  }
  : "${RESEND_API_KEY:?RESEND_API_KEY is required when registration is enabled}"
  : "${RESEND_FROM:?RESEND_FROM is required when registration is enabled}"
fi
exec "$@"
