#!/usr/bin/env sh
set -eu

: "${APP_BASE_URL:?APP_BASE_URL is required}"
: "${REGISTRATION_ENABLED:?REGISTRATION_ENABLED is required}"
case "$REGISTRATION_ENABLED" in
  true|false) ;;
  *) echo "REGISTRATION_ENABLED must be true or false." >&2; exit 1 ;;
esac
# The database and the signing secret are needed whether or not this site is
# taking registrations. A report link is signed on the way out and checked on
# the way back in either case, and a process that fell back to a default here
# would sign with whatever the image was built beside.
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${TOKEN_HMAC_SECRET:?TOKEN_HMAC_SECRET is required}"
[ "${#TOKEN_HMAC_SECRET}" -ge 32 ] || {
  echo "TOKEN_HMAC_SECRET must contain at least 32 characters." >&2
  exit 1
}
# The cabinet's private route is only asked anything when an address is being
# confirmed, which is what registration is.
if [ "$REGISTRATION_ENABLED" = "true" ]; then
  : "${CABINET_IDENTITY_URL:?CABINET_IDENTITY_URL is required when registration is enabled}"
  : "${REPORT_IDENTITY_SECRET:?REPORT_IDENTITY_SECRET is required when registration is enabled}"
  [ "${#REPORT_IDENTITY_SECRET}" -ge 32 ] || {
    echo "REPORT_IDENTITY_SECRET must contain at least 32 characters." >&2
    exit 1
  }
fi
exec "$@"
