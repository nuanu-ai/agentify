#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${CUTOVER_DUMP_BASENAME:?CUTOVER_DUMP_BASENAME is required}"

[ "${DATABASE_MODE:-local}" = "external" ] || {
  echo "Public-data import is allowed only with DATABASE_MODE=external." >&2
  exit 1
}
[ "${CUTOVER_IMPORT_ACK:-}" = "import-into-empty-agentify-public" ] || {
  echo "Set CUTOVER_IMPORT_ACK=import-into-empty-agentify-public to acknowledge the destructive cutover step." >&2
  exit 1
}
case "$CUTOVER_DUMP_BASENAME" in
  agentify-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump) ;;
  *) echo "CUTOVER_DUMP_BASENAME is not an Agentify backup basename." >&2; exit 1 ;;
esac

/runtime-validate-database-config.sh

dump="/backups/$CUTOVER_DUMP_BASENAME"
test -s "$dump" || { echo "Cutover dump is missing or empty." >&2; exit 1; }
pg_restore --list "$dump" >/dev/null

psql --dbname "$DATABASE_URL" --set=ON_ERROR_STOP=1 <<'SQL'
DO $empty_destination$
DECLARE
  table_row record;
  row_count bigint;
BEGIN
  IF to_regclass('public.scans') IS NULL OR to_regclass('public.leads') IS NULL THEN
    RAISE EXCEPTION 'Agentify migrations are not present in the destination';
  END IF;

  FOR table_row IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', table_row.schema_name, table_row.table_name)
      INTO row_count;
    IF row_count <> 0 THEN
      RAISE EXCEPTION 'destination table %.% is not empty', table_row.schema_name, table_row.table_name;
    END IF;
  END LOOP;
END
$empty_destination$;
SQL

set_foreign_key_mode() {
  mode="$1"
  case "$mode" in
    deferred) clause="DEFERRABLE INITIALLY DEFERRED" ;;
    immediate) clause="NOT DEFERRABLE" ;;
    *) echo "Unknown foreign-key mode." >&2; return 1 ;;
  esac

  psql --dbname "$DATABASE_URL" --set=ON_ERROR_STOP=1 \
    --set=constraint_clause="$clause" <<'SQL' >/dev/null
SELECT format(
  'ALTER TABLE %I.%I ALTER CONSTRAINT %I %s',
  namespace.nspname,
  relation.relname,
  constraint_row.conname,
  :'constraint_clause'
)
FROM pg_constraint constraint_row
JOIN pg_class relation ON relation.oid = constraint_row.conrelid
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE constraint_row.contype = 'f'
  AND namespace.nspname = 'public'
  AND relation.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
ORDER BY relation.relname, constraint_row.conname
\gexec
SQL
}

# A pg_dump TOC does not guarantee parent-before-child table-data order, and
# Supabase intentionally does not grant the superuser capability required by
# pg_restore --disable-triggers. Defer only Agentify-owned foreign keys while
# the single restore transaction runs, then restore the migration-defined
# NOT DEFERRABLE contract even when pg_restore fails.
set_foreign_key_mode deferred
restore_foreign_key_mode() {
  set_foreign_key_mode immediate
}
trap 'restore_foreign_key_mode || true' EXIT HUP INT TERM

pg_restore --dbname "$DATABASE_URL" \
  --data-only \
  --schema=public \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-acl \
  "$dump"

restore_foreign_key_mode
trap - EXIT HUP INT TERM

psql --dbname "$DATABASE_URL" --set=ON_ERROR_STOP=1 --command 'ANALYZE public.scans; ANALYZE public.leads;' >/dev/null
echo "Agentify public data imported into the empty external database."
