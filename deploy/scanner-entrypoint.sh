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
  : "${CABINET_IDENTITY_URL:?CABINET_IDENTITY_URL is required when registration is enabled}"
  : "${REPORT_IDENTITY_SECRET:?REPORT_IDENTITY_SECRET is required when registration is enabled}"
  [ "${#REPORT_IDENTITY_SECRET}" -ge 32 ] || {
    echo "REPORT_IDENTITY_SECRET must contain at least 32 characters." >&2
    exit 1
  }
fi
exec "$@"
