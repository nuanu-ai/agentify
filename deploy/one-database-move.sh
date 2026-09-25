#!/bin/sh
# The database half of the one-time move to one database (deploy/README.md,
# "One database"). It runs inside the channel's PostgreSQL container, fed on
# stdin by deploy/one-database.sh, which owns everything around it:
#
#   docker exec -i <postgres> sh -s -- move            < deploy/one-database-move.sh
#   docker exec -i <postgres> sh -s -- finish          < deploy/one-database-move.sh
#   docker exec -i <postgres> sh -s -- fingerprints <database> < deploy/one-database-move.sh
#   docker exec -i <postgres> sh -s -- scanner-database < deploy/one-database-move.sh
#
# `move` puts the scanner's tables, types and rows into the public schema of
# agentify_commerce, and its migration history into drizzle.scanner_migrations
# beside the gateway's and the cabinet's, in one transaction: either all of it
# arrives or none of it does. It leaves behind what the survey found on the
# hosts and nothing in this repository creates — the policies and grants that
# name the four retired service roles — and it does not move the scanner's
# pg-boss schema, which must hold no unfinished job. It refuses before it
# writes anything when a job is unfinished, when anything is connected to the
# scanner's database, or when a name in its public schema is already taken. A
# second run finds drizzle.scanner_migrations and moves nothing.
#
# `finish` drops the scanner's database, which takes its pg-boss schema, its
# metabase views and every policy naming the old roles with it, the test
# suites' scratch database under its old name, then the four roles, and
# renames the database and the bootstrap account to agentify. The
# account is the one initdb created, which PostgreSQL will not drop, so it is
# renamed rather than replaced, by a superuser that exists for that one
# statement. Every step looks before it acts, so a second run repeats only
# what the first did not finish.
#
# `fingerprints` prints one line per table, name|rows|md5 of its rows in a
# fixed order, which is what deploy/one-database.sh compares before and after,
# and `scanner-database` says whether agentify_scanner is still there, present
# or absent, whatever the account is called by then.
set -eu

mode="${1:-}"
trap 'rm -f /tmp/one-database.*' EXIT
say() { echo "one-database: $*" >&2; }
refuse() { echo "one-database: $*" >&2; exit 1; }
# The bootstrap account answers to its old name until `finish` renames it.
role=agentify_commerce
psql -X -U "$role" -d postgres -Atc 'select 1' > /dev/null 2>&1 || role=agentify
q() { PGOPTIONS='-c client_min_messages=warning' psql -X -q -v ON_ERROR_STOP=1 -U "$role" -At "$@"; }
has_database() { [ "$(q -d postgres -c "select count(*) from pg_database where datname = '$1'")" = 1 ]; }
moved() { [ "$(q -d agentify_commerce -c "select to_regclass('drizzle.scanner_migrations') is not null")" = t ]; }

fingerprints() {
  q -d "$1" <<'SQL'
SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM %I.%I t',
              n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
ORDER BY 1 \gexec
SQL
}

move() {
  if has_database agentify && ! has_database agentify_scanner; then
    say "the server already holds the one database, agentify; nothing was moved."
    return
  fi
  if ! has_database agentify_scanner || ! has_database agentify_commerce; then
    refuse "the server holds neither agentify_commerce nor agentify_scanner as the move expects; nothing was moved."
  fi
  if moved; then
    say "the scanner's tables are already in agentify_commerce; nothing was moved again."
    return
  fi
  if [ "$(q -d agentify_scanner -c "select to_regclass('pgboss.job') is not null")" = t ]; then
    unfinished="$(q -d agentify_scanner -c "select count(*) from pgboss.job where state in ('created', 'retry', 'active')")"
    [ "$unfinished" = 0 ] \
      || refuse "the scanner's queue holds $unfinished unfinished jobs, which the move would lose; nothing was moved."
  fi
  connected="$(q -d postgres -c "select count(*) from pg_stat_activity where datname = 'agentify_scanner' and backend_type = 'client backend'")"
  [ "$connected" = 0 ] || refuse "$connected sessions are connected to agentify_scanner; nothing was moved."
  names="select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
         union select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public'"
  q -d agentify_scanner -c "$names" | sort > /tmp/one-database.names
  taken="$(q -d agentify_commerce -c "$names" | sort | comm -12 - /tmp/one-database.names | tr '\n' ' ')"
  [ -z "$taken" ] || refuse "agentify_commerce already has these names the scanner's tables use: ${taken}; nothing was moved."
  say "moving the scanner's tables and their migration history into agentify_commerce"
  pg_dump -U "$role" -Fc --no-privileges -n public agentify_scanner > /tmp/one-database.dump
  # The schema itself exists in the target, and the policies name roles that go.
  pg_restore -l /tmp/one-database.dump \
    | grep -Ev '^[0-9]+; [0-9]+ [0-9]+ (SCHEMA|POLICY|COMMENT - SCHEMA) ' > /tmp/one-database.list
  {
    pg_restore -L /tmp/one-database.list -f - /tmp/one-database.dump
    # The table drizzle's migrator creates, under the name the scanner's
    # migrations are read from now (packages/scanner-database/src/migrate.ts).
    echo 'CREATE TABLE drizzle.scanner_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);'
    echo 'COPY drizzle.scanner_migrations (id, hash, created_at) FROM stdin;'
    q -d agentify_scanner -c 'COPY (SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id) TO STDOUT'
    echo '\.'
    echo "SELECT setval(pg_get_serial_sequence('drizzle.scanner_migrations', 'id'), max(id)) FROM drizzle.scanner_migrations;"
  } > /tmp/one-database.sql
  q -d agentify_commerce --single-transaction -f /tmp/one-database.sql > /dev/null
  say "moved $(q -d agentify_commerce -c 'select count(*) from drizzle.scanner_migrations') migrations' history and the tables of public"
}

finish() {
  if has_database agentify_scanner; then
    if ! has_database agentify_commerce || ! moved; then
      refuse "agentify_scanner is still the only copy of the scanner's tables, so it was not dropped."
    fi
    say "dropping agentify_scanner"
    q -d postgres -c 'DROP DATABASE agentify_scanner'
  fi
  q -d postgres -c 'DROP DATABASE IF EXISTS agentify_commerce_test'
  for old in agentify_web agentify_worker agentify_privacy agentify_dashboard; do
    q -d postgres -c "DROP ROLE IF EXISTS $old"
  done
  if has_database agentify_commerce; then
    ! has_database agentify || refuse "both agentify and agentify_commerce exist, so neither was renamed."
    say "renaming agentify_commerce to agentify"
    q -d postgres -c 'ALTER DATABASE agentify_commerce RENAME TO agentify'
  fi
  if [ "$role" = agentify_commerce ]; then
    say "renaming the account agentify_commerce to agentify"
    [ "$(q -d postgres -c "select count(*) from pg_roles where rolname = 'agentify_rename'")" = 1 ] \
      || q -d postgres -c 'CREATE ROLE agentify_rename SUPERUSER LOGIN'
    psql -X -q -v ON_ERROR_STOP=1 -U agentify_rename -d postgres -c 'ALTER ROLE agentify_commerce RENAME TO agentify'
    role=agentify
  fi
  q -d postgres -c 'DROP ROLE IF EXISTS agentify_rename'
  say "the server holds one database, agentify, reached by the account agentify"
}

case "$mode" in
  move) move ;;
  finish) finish ;;
  fingerprints) fingerprints "${2:?name the database}" ;;
  scanner-database) if has_database agentify_scanner; then echo present; else echo absent; fi ;;
  *) refuse "usage: sh -s -- move|finish|fingerprints <database>|scanner-database" ;;
esac
