-- The databases the test suites empty, beside the one the stack runs on.
--
-- `pnpm test:db` drops the queue's schema and truncates every table it finds,
-- and `pnpm scanner:test:db` drops and remakes every schema it is given. Given
-- the stack's own database they do that to the catalogue a merchant has just
-- published and the orders the cabinet is showing, while somebody is looking at
-- them, and say nothing about it afterwards.
--
-- Postgres runs the files in /docker-entrypoint-initdb.d only when it
-- initialises an empty data directory, and the volume outlives
-- `docker compose down`. So this covers a fresh volume and nothing else: what
-- makes `agentify_test` exist on a volume that is already there is the suite
-- itself, in apps/gateway/src/testing/database.ts, and the scanner's suite is
-- pointed at its database by MIGRATION_TEST_DATABASE_URL (.env.scanner.example).
-- This file is here so that a psql session on a new machine finds both without
-- running a suite first, and so that the split is visible in the stack rather
-- than only in the tests.
CREATE DATABASE agentify_test;
CREATE DATABASE agentify_scanner_migration_test;
