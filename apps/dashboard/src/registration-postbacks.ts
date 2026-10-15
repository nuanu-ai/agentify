/**
 * Tells the ad tracker that a person its ad sent signed up, once per consented
 * registration: the click id and the word `reg`, nothing about the person.
 *
 * A turn is one transaction. It takes a lock every process and replica shares,
 * which spaces posts across all of them at least 1.1 seconds apart; takes one
 * due row, locked so no other turn can take it; posts; and records the outcome
 * before committing. A 200 delivers the report, a 429, a 5xx, a timeout or a
 * network failure tries it again later, and anything else, a redirect
 * included, refuses it for good; the click is erased from every row that is
 * final. A day after the registration nothing more is tried.
 *
 * A process that stops after the tracker accepted a post and before the
 * commit leaves the row pending, and it is posted again. That cannot become a
 * second conversion: the tracker keeps one `reg` per click.
 */

import { failureNamed } from "@agentify/gateway/failure-named";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { DashboardConfig } from "./config.js";
import { registrationPostbacks } from "./schema.js";

/**
 * The two-number form keeps this lock apart from every lock taken with one
 * number, such as the per-address ones; the numbers spell "dash" and "regp".
 */
const SPACING_LOCK = [0x64617368, 0x72656770] as const;
const SPACED_MS = 1_100;
const DEADLINE_MS = 5_000;
const IDLE_MS = 5_000;
const RETRIED_FOR_MS = 24 * 60 * 60 * 1_000;
/** The n-th failure waits the n-th of these, and every failure after them six hours. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const LAST_RETRY_DELAY_MS = 6 * 60 * 60_000;

export interface ReportParts {
  readonly pool: Pool;
  readonly target: NonNullable<DashboardConfig["registrationPostback"]>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly wait?: (ms: number) => Promise<void>;
}

type Final = "delivered" | "refused" | "given_up";

/** How a turn ended, which is all a log line says about it. */
type Said = Readonly<{ state: Final | "pending"; outcome: string }>;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The outcome of one post as the row records it, and what follows from it. */
const posted = async (
  post: typeof fetch,
  target: ReportParts["target"],
  clickId: string,
): Promise<Readonly<{ outcome: string; next: Final | "retry" }>> => {
  try {
    const response = await post(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-postback-key": target.key },
      body: JSON.stringify({ clickid: clickId, event: "reg" }),
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    // Nothing reads the body; cancelling it frees the connection.
    response.body?.cancel().catch(() => undefined);
    const outcome = `http_${response.status}`;
    if (response.status === 200) return { outcome, next: "delivered" };
    return {
      outcome,
      next: response.status === 429 || response.status >= 500 ? "retry" : "refused",
    };
  } catch (thrown) {
    const name = thrown instanceof Error ? thrown.name : "";
    return {
      outcome: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
      next: "retry",
    };
  }
};

/**
 * One turn: false when no report was due. A failure of the database is thrown,
 * and the transaction's rollback leaves the row as it was.
 */
export async function reportOnce(parts: ReportParts): Promise<boolean> {
  const now = parts.now ?? (() => new Date());
  const said = await drizzle(parts.pool).transaction(async (tx): Promise<Said | null> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${SPACING_LOCK[0]}::integer, ${SPACING_LOCK[1]}::integer)`,
    );
    const [due] = await tx
      .select({
        accountId: registrationPostbacks.accountId,
        clickId: registrationPostbacks.clickId,
        attempts: registrationPostbacks.attempts,
        createdAt: registrationPostbacks.createdAt,
      })
      .from(registrationPostbacks)
      .where(
        and(
          eq(registrationPostbacks.state, "pending"),
          lte(registrationPostbacks.nextAttemptAt, now()),
        ),
      )
      .orderBy(asc(registrationPostbacks.nextAttemptAt), asc(registrationPostbacks.accountId))
      .limit(1)
      .for("update", { skipLocked: true });
    if (due === undefined) return null;

    const theRow = eq(registrationPostbacks.accountId, due.accountId);
    const settle = async (state: Final, outcome: string, attempts: number): Promise<Said> => {
      await tx
        .update(registrationPostbacks)
        .set({
          state,
          clickId: null,
          attempts,
          nextAttemptAt: null,
          lastOutcome: outcome,
          settledAt: now(),
        })
        .where(theRow);
      return { state, outcome };
    };
    const windowEnds = due.createdAt.getTime() + RETRIED_FOR_MS;
    if (due.clickId === null) {
      throw new Error("a pending registration holds no click, which its table refuses");
    }

    if (now().getTime() >= windowEnds) {
      // The row keeps the tracker's last answer, or none where it was never
      // asked; the state and the moment it settled say the day ran out.
      await tx
        .update(registrationPostbacks)
        .set({ state: "given_up", clickId: null, nextAttemptAt: null, settledAt: now() })
        .where(theRow);
      return { state: "given_up", outcome: "retry_window_exhausted" };
    }

    const started = now().getTime();
    try {
      const { outcome, next } = await posted(parts.fetch ?? fetch, parts.target, due.clickId);
      const attempts = due.attempts + 1;
      if (next !== "retry") return await settle(next, outcome, attempts);
      const nextAt = now().getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? LAST_RETRY_DELAY_MS);
      if (nextAt >= windowEnds) return await settle("given_up", outcome, attempts);
      await tx
        .update(registrationPostbacks)
        .set({ attempts, nextAttemptAt: new Date(nextAt), lastOutcome: outcome })
        .where(theRow);
      return { state: "pending", outcome };
    } finally {
      // The lock is held until the spacing has passed since this post began,
      // so the next post, from any process, cannot begin sooner; also when the
      // outcome could not be recorded, which leaves the row to be posted again.
      const left = SPACED_MS - (now().getTime() - started);
      if (left > 0) await (parts.wait ?? pause)(left);
    }
  });
  if (said === null) return false;
  console.log(`[dashboard] registration report ${said.state}: ${said.outcome}`);
  return true;
}

export interface RegistrationReports {
  /** Settles once the turn in flight has ended. */
  stop(): Promise<void>;
}

/**
 * Turns one after another, pausing when nothing was due or a turn failed. A
 * turn that fails, such as one the database did not answer, is logged and the
 * loop goes on.
 */
export function startRegistrationReports(
  parts: ReportParts & { readonly idleMs?: number },
): RegistrationReports {
  let running = true;
  let wake: (() => void) | null = null;
  // Cut short by a stop, so the process does not wait out the pause.
  const idle = async (): Promise<void> => {
    const ms = parts.idleMs ?? IDLE_MS;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (parts.wait === undefined) timer = setTimeout(resolve, ms);
      else void parts.wait(ms).then(resolve);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  };

  const done = (async () => {
    while (running) {
      let took = false;
      try {
        took = await reportOnce(parts);
      } catch (thrown) {
        console.error(`[dashboard] a registration report turn failed: ${failureNamed(thrown)}`);
      }
      if (!took && running) await idle();
    }
  })();

  return {
    async stop() {
      running = false;
      (wake as (() => void) | null)?.();
      await done;
    },
  };
}
