-- The scanner's database, beside the one the gateway and the cabinet share.
--
-- Two databases on one server, not two servers: the scanner used to bring up a
-- PostgreSQL of its own, which meant a second container, a second port and a
-- second thing to remember on a laptop that is running one product. One
-- database is where this is going (ADR-0003 §2) and is not today's step; this
-- is the arrangement in between, and it is the one both deployed channels
-- already run.
--
-- The owner is the server's own role, so the scanner's processes connect with
-- the same credentials the gateway and the cabinet use and own everything they
-- create. There is no second user and no per-service role here: on a laptop
-- there is nobody to keep apart.
CREATE DATABASE agentify_scanner;

-- What `pnpm scanner:test:db` migrates and drops. It is a separate database
-- for the reason the commerce suite has one: that suite empties what it is
-- given, and `agentify_scanner` is what the front page is showing.
CREATE DATABASE agentify_scanner_migration_test;

-- The same caveat the file beside this one carries: PostgreSQL runs
-- /docker-entrypoint-initdb.d only when it initialises an empty data
-- directory, and the volume outlives `docker compose down`. A machine that ran
-- this stack before these two databases existed needs `docker compose down -v`
-- once, or the two CREATE DATABASE statements above by hand.
