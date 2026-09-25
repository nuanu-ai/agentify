-- Being an operator is a flag on the account (ADR-0026 §6). Every row already
-- here, and every row a sign-in writes, starts without it; only the terminal
-- command `pnpm account operator` sets it.
ALTER TABLE "cabinet_accounts" ADD COLUMN "operator" boolean DEFAULT false NOT NULL;
