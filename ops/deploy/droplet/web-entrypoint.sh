#!/usr/bin/env sh
set -eu

: "${APP_BASE_URL:?APP_BASE_URL is required}"
: "${REGISTRATION_ENABLED:?REGISTRATION_ENABLED is required}"
case "$REGISTRATION_ENABLED" in
  true|false) ;;
  *) echo "REGISTRATION_ENABLED must be true or false." >&2; exit 1 ;;
esac
if [ "$REGISTRATION_ENABLED" = "true" ]; then
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
