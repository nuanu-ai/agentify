#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

/runtime-validate-database-config.sh

psql --dbname "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
  --file=/runtime-dashboards/install-aggregate-views.sql >/dev/null
echo "PII-minimized database dashboard views installed."
