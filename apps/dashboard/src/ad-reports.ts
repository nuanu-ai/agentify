/**
 * Tells the ad tracker what a person its ad sent went on to do, by the click id
 * alone: that they signed up (`reg`), once per registration, and that the
 * merchant their account names published its first card (`store_connected`),
 * once per merchant.
 *
 * A turn is one transaction. It takes a lock every process and replica shares,
 * which spaces posts of both kinds across all of them at least 1.1 seconds
 * apart. Under it, the store reports still waiting are settled first: of a
 * merchant whose first card came at or after a registration and within 30 days
 * of it, the earliest such registration's report becomes due once that
 * registration's own report was delivered, and every waiting report that can no
 * longer become due lapses, loses its click and records why. Then the turn
 * takes one due row, locked so no other turn can take it; posts; and records
 * the outcome before committing. A 200 delivers the report, a 429, a 5xx, a
 * timeout or a network failure tries it again later, and anything else, a
 * redirect included, refuses it for good; the click is erased from every row
 * that is final. Nothing more is tried a day after the reported fact, nor 30
 * days after the registration.
 *
 * A process that stops after the tracker accepted a post and before the
 * commit leaves the row pending, and it is posted again. For `reg` that cannot
 * become a second conversion, since the tracker keeps one `reg` per click; for
 * `store_connected` it relies on the tracker keeping one per click too, which
 * the tracker has not confirmed.
 *
 * Switched off, the loop still runs and posts nothing: it gives up every
 * report still pending once its time is over and lapses every store report
 * that can no longer become due, so no click outlives them because the switch
 * went off. With only the store report off, registrations are still posted.
 */

import { failureNamed } from "@agentify/gateway/failure-named";
import { and, asc, eq, inArray, lte, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { DashboardConfig } from "./config.js";
import { adReports } from "./schema.js";

/**
 * The two-number form keeps this lock apart from every lock taken with one
 * number, such as the per-address ones; the numbers spell "dash" and "regp".
 */
const SPACING_LOCK = [0x64617368, 0x72656770] as const;
const SPACED_MS = 1_100;
const DEADLINE_MS = 5_000;
const IDLE_MS = 5_000;
/** Switched off, how long a click can stay past its day. */
const EXPIRY_IDLE_MS = 60_000;
const RETRIED_FOR_MS = 24 * 60 * 60 * 1_000;
/** How long after the registration a first card still counts, and the click is kept. */
const KEPT_FOR_MS = 30 * RETRIED_FOR_MS;
/** The n-th failure waits the n-th of these, and every failure after them six hours. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const LAST_RETRY_DELAY_MS = 6 * 60 * 60_000;

type Target = NonNullable<DashboardConfig["registrationPostback"]>;
type Event = "reg" | "store_connected";

interface LoopParts {
  readonly pool: Pool;
  readonly now?: () => Date;
  readonly wait?: (ms: number) => Promise<void>;
}

interface ReportParts extends LoopParts {
  readonly target: Target;
  /** Whether a merchant's first card is reported as well as a registration. */
  readonly storeConnected: boolean;
  readonly fetch?: typeof fetch;
}

type Final = "delivered" | "refused" | "given_up";

/** How a turn ended, which is all a log line says about it. */
type Said = Readonly<{ event: Event; state: Final | "pending"; outcome: string }>;

/**
 * What a turn did before it posted, counted for the log: the store reports that
 * became due, those given up because they would have become due only after
 * their time, those lapsed by the reason each recorded, and the pending
 * reports given up while switched off.
 */
type Tidied = Readonly<{
  due: number;
  late: number;
  lapsed: Readonly<Record<string, number>>;
  givenUp: number;
}>;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const lockedForPosting = sql`select pg_advisory_xact_lock(${SPACING_LOCK[0]}::integer, ${SPACING_LOCK[1]}::integer)`;

const span = (ms: number): SQL => sql`(${ms}::double precision * interval '1 millisecond')`;

/** The moment after which a report of this fact and registration is no longer tried. */
const lastTry = (eventAt: SQLWrapper, createdAt: SQLWrapper): SQL =>
  sql`least(${eventAt} + ${span(RETRIED_FOR_MS)}, ${createdAt} + ${span(KEPT_FOR_MS)})`;

const lastTryOf = (row: Readonly<{ eventAt: Date; createdAt: Date }>): number =>
  Math.min(row.eventAt.getTime() + RETRIED_FOR_MS, row.createdAt.getTime() + KEPT_FOR_MS);

const nameOf = (event: Event): string => (event === "reg" ? "registration" : "store");

const counted = (count: number, one: string, many: string): string =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

/**
 * A row given up keeps the tracker's last answer, or none where it was never
 * asked; its state and the moment it settled say the time ran out.
 */
const givenUp = (at: Date) =>
  ({ state: "given_up", clickId: null, nextAttemptAt: null, settledAt: at }) as const;

/** What one report says, exactly; nothing about the person or the store. */
const bodyOf = (event: Event, clickId: string, eventAt: Date): string =>
  JSON.stringify(
    event === "reg"
      ? { clickid: clickId, event }
      : { clickid: clickId, event, event_time: Math.floor(eventAt.getTime() / 1_000) },
  );

/** The outcome of one post as the row records it, and what follows from it. */
const posted = async (
  post: typeof fetch,
  target: Target,
  body: string,
): Promise<Readonly<{ outcome: string; next: Final | "retry" }>> => {
  try {
    const response = await post(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-postback-key": target.key },
      body,
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

type Transaction = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

/**
 * Settles, in one statement, every store report still waiting. Of a merchant
 * whose first card ever was published at or after a waiting registration and
 * before its 30 days ended, the earliest such registration whose own report was
 * not refused or given up holds the store report, unless an account of the
 * merchant already took it. That report becomes due, dated by the card, once
 * its registration's report was delivered, or is given up at once, never
 * posted, if the time to post it has already passed; until then, or while it is
 * switched off, it waits, until its 30 days end. Every other waiting report
 * lapses once it can no longer become due, its click erased and the reason
 * recorded as its last outcome: its registration's report was not delivered,
 * its merchant's first card came before the registration or is another
 * account's to report, it was switched off until its 30 days ended, or no first
 * card came within them. A card row exists only once a publish succeeded, and
 * on the live channel cards are not deleted, so a merchant's first card never
 * changes there; the test channel's forget command deletes a merchant's cards
 * only together with its one account and that account's reports.
 *
 * A row whose account is being deleted at that moment is skipped rather than
 * waited for, since the lock every process shares is held.
 */
async function settleWaiting(
  tx: Transaction,
  at: Date,
  promote: boolean,
): Promise<Pick<Tidied, "due" | "late" | "lapsed">> {
  const keptFor = span(KEPT_FOR_MS);
  const settled = await tx.execute<{ fate: string }>(sql`
    with waiting as (
      select r.account_id, r.created_at, a.merchant_id, reg.state as registration
        from dashboard_ad_reports r
        join dashboard_accounts a on a.id = r.account_id
        join dashboard_ad_reports reg on reg.account_id = r.account_id and reg.event = 'reg'
       where r.event = 'store_connected' and r.state = 'waiting'
         for update of r skip locked
    ),
    first_cards as (
      select c.merchant_id, min(c.published_at) as published_at
        from cards c
       where c.merchant_id in (select w.merchant_id from waiting w)
       group by c.merchant_id
    ),
    chosen as (
      select distinct on (w.merchant_id) w.account_id, f.published_at
        from waiting w
        join first_cards f on f.merchant_id = w.merchant_id
       where f.published_at >= w.created_at
         and f.published_at < w.created_at + ${keptFor}
         and w.registration not in ('refused', 'given_up')
         and not exists (
           select 1
             from dashboard_ad_reports taken
             join dashboard_accounts owner on owner.id = taken.account_id
            where owner.merchant_id = w.merchant_id
              and taken.event = 'store_connected'
              and taken.state not in ('waiting', 'lapsed')
         )
       order by w.merchant_id, w.created_at, w.account_id
    ),
    fates as (
      select w.account_id, c.published_at,
             case
               when w.registration in ('refused', 'given_up') then 'registration_not_delivered'
               when c.account_id is not null then
                 case
                   when w.registration = 'delivered' and ${promote}::boolean then
                     case
                       when ${at}::timestamptz < ${lastTry(sql`c.published_at`, sql`w.created_at`)}
                         then 'due'
                       else 'late'
                     end
                   when ${at}::timestamptz < w.created_at + ${keptFor} then null
                   when w.registration = 'delivered' then 'switched_off_past_30_days'
                   else 'registration_not_delivered'
                 end
               when f.published_at < w.created_at then 'first_card_before_registration'
               when f.published_at < w.created_at + ${keptFor} then 'belongs_to_another_account'
               when ${at}::timestamptz >= w.created_at + ${keptFor} then 'no_first_card_in_30_days'
             end as fate
        from waiting w
        left join first_cards f on f.merchant_id = w.merchant_id
        left join chosen c on c.account_id = w.account_id
    )
    update dashboard_ad_reports r
       set state = case fates.fate when 'due' then 'pending' when 'late' then 'given_up' else 'lapsed' end,
           click_id = case when fates.fate = 'due' then r.click_id end,
           event_at = case when fates.fate in ('due', 'late') then fates.published_at end,
           next_attempt_at = case when fates.fate = 'due' then ${at}::timestamptz end,
           last_outcome = case when fates.fate not in ('due', 'late') then fates.fate end,
           settled_at = case when fates.fate <> 'due' then ${at}::timestamptz end
      from fates
     where r.account_id = fates.account_id
       and r.event = 'store_connected'
       and fates.fate is not null
    returning fates.fate
  `);
  const tidied = { due: 0, late: 0, lapsed: {} as Record<string, number> };
  for (const { fate } of settled.rows) {
    if (fate === "due" || fate === "late") tidied[fate] += 1;
    else tidied.lapsed[fate] = (tidied.lapsed[fate] ?? 0) + 1;
  }
  return tidied;
}

/** Gives up, without posting, every pending report of these events whose time ran out. */
async function giveUpLate(tx: Transaction, at: Date, events: readonly Event[]): Promise<number> {
  const given = await tx
    .update(adReports)
    .set(givenUp(at))
    .where(
      and(
        eq(adReports.state, "pending"),
        inArray(adReports.event, [...events]),
        sql`${lastTry(adReports.eventAt, adReports.createdAt)} <= ${at}::timestamptz`,
      ),
    )
    .returning({ event: adReports.event });
  return given.length;
}

const tell = (tidied: Tidied, off: string): void => {
  if (tidied.due > 0) {
    console.log(
      `[dashboard] ${counted(tidied.due, "store report", "store reports")} became due with a first card`,
    );
  }
  if (tidied.late > 0) {
    console.log(
      `[dashboard] ${counted(tidied.late, "store report found only after its time was", "store reports found only after their time were")} given up`,
    );
  }
  for (const [reason, count] of Object.entries(tidied.lapsed)) {
    console.log(
      `[dashboard] ${counted(count, "waiting store report", "waiting store reports")} lapsed: ${reason}`,
    );
  }
  if (tidied.givenUp > 0) {
    console.log(
      `[dashboard] ${off} reporting is switched off, so` +
        ` ${counted(tidied.givenUp, "pending report past its time was", "pending reports past their time were")} given up`,
    );
  }
};

/**
 * One turn: false when no report was due. A failure of the database is thrown,
 * and the transaction's rollback leaves every row as it was.
 */
export async function reportOnce(parts: ReportParts): Promise<boolean> {
  const now = parts.now ?? (() => new Date());
  const reported: Event[] = parts.storeConnected ? ["reg", "store_connected"] : ["reg"];
  type Turn = Readonly<{ tidied: Tidied; said: Said | null }>;
  const turn = await drizzle(parts.pool).transaction(async (tx): Promise<Turn> => {
    await tx.execute(lockedForPosting);
    const waiting = await settleWaiting(tx, now(), parts.storeConnected);
    const tidied: Tidied = {
      ...waiting,
      givenUp: parts.storeConnected ? 0 : await giveUpLate(tx, now(), ["store_connected"]),
    };
    const [due] = await tx
      .select({
        accountId: adReports.accountId,
        event: adReports.event,
        clickId: adReports.clickId,
        attempts: adReports.attempts,
        createdAt: adReports.createdAt,
        eventAt: adReports.eventAt,
      })
      .from(adReports)
      .where(
        and(
          eq(adReports.state, "pending"),
          inArray(adReports.event, reported),
          lte(adReports.nextAttemptAt, now()),
        ),
      )
      .orderBy(asc(adReports.nextAttemptAt), asc(adReports.accountId), asc(adReports.event))
      .limit(1)
      .for("update", { skipLocked: true });
    if (due === undefined) return { tidied, said: null };
    if (due.clickId === null || due.eventAt === null) {
      throw new Error("a pending report holds no click or no date, which its table refuses");
    }
    const event = due.event as Event;
    const { clickId, eventAt } = due;

    const theRow = and(eq(adReports.accountId, due.accountId), eq(adReports.event, event));
    const settle = async (state: Final, outcome: string, attempts: number): Promise<Said> => {
      await tx
        .update(adReports)
        .set({
          state,
          clickId: null,
          attempts,
          nextAttemptAt: null,
          lastOutcome: outcome,
          settledAt: now(),
        })
        .where(theRow);
      return { event, state, outcome };
    };
    const windowEnds = lastTryOf({ eventAt, createdAt: due.createdAt });

    if (now().getTime() >= windowEnds) {
      await tx.update(adReports).set(givenUp(now())).where(theRow);
      return { tidied, said: { event, state: "given_up", outcome: "retry_window_exhausted" } };
    }

    const started = now().getTime();
    try {
      const { outcome, next } = await posted(
        parts.fetch ?? fetch,
        parts.target,
        bodyOf(event, clickId, eventAt),
      );
      const attempts = due.attempts + 1;
      if (next !== "retry") return { tidied, said: await settle(next, outcome, attempts) };
      const nextAt = now().getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? LAST_RETRY_DELAY_MS);
      if (nextAt >= windowEnds) {
        return { tidied, said: await settle("given_up", outcome, attempts) };
      }
      await tx
        .update(adReports)
        .set({ attempts, nextAttemptAt: new Date(nextAt), lastOutcome: outcome })
        .where(theRow);
      return { tidied, said: { event, state: "pending", outcome } };
    } finally {
      // The lock is held until the spacing has passed since this post began,
      // so the next post, from any process, cannot begin sooner; also when the
      // outcome could not be recorded, which leaves the row to be posted again.
      const left = SPACED_MS - (now().getTime() - started);
      if (left > 0) await (parts.wait ?? pause)(left);
    }
  });
  tell(turn.tidied, "store");
  if (turn.said === null) return false;
  console.log(
    `[dashboard] ${nameOf(turn.said.event)} report ${turn.said.state}: ${turn.said.outcome}`,
  );
  return true;
}

/**
 * Settles, without posting, what the time left: gives up every report still
 * pending once its time is over and lapses every store report that can no
 * longer become due. Under the same lock as a post, so it never takes a row
 * from under a turn of a process that still reports, and two processes doing
 * this at once never lock the same rows in opposite orders.
 */
async function expireOnce(parts: LoopParts): Promise<void> {
  const now = parts.now ?? (() => new Date());
  const tidied = await drizzle(parts.pool).transaction(async (tx) => {
    await tx.execute(lockedForPosting);
    // Registrations first, so a store report whose registration this gives up
    // lapses in the same turn.
    const givenUp = await giveUpLate(tx, now(), ["reg", "store_connected"]);
    return { ...(await settleWaiting(tx, now(), false)), givenUp };
  });
  tell(tidied, "registration");
}

export interface AdReports {
  /** Settles once the turn in flight has ended. */
  stop(): Promise<void>;
}

/**
 * Started on every dashboard: with a target it reports, and with none, where
 * reporting is switched off, it only settles what the time left. Turns run one
 * after another, pausing when nothing was due or a turn failed; a turn that
 * fails, such as one the database did not answer, is logged and the loop goes
 * on.
 */
export function startAdReports(
  parts: LoopParts &
    Readonly<{
      target: Target | null;
      storeConnected: boolean;
      fetch?: typeof fetch;
      idleMs?: number;
    }>,
): AdReports {
  const { target } = parts;
  // Expiry takes every row it can in one turn, so it always pauses after one.
  const turn =
    target === null
      ? async (): Promise<boolean> => {
          await expireOnce(parts);
          return false;
        }
      : async (): Promise<boolean> => await reportOnce({ ...parts, target });
  let running = true;
  let wake: (() => void) | null = null;
  // Cut short by a stop, so the process does not wait out the pause.
  const idle = async (): Promise<void> => {
    const ms = parts.idleMs ?? (target === null ? EXPIRY_IDLE_MS : IDLE_MS);
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
        took = await turn();
      } catch (thrown) {
        console.error(`[dashboard] an ad report turn failed: ${failureNamed(thrown)}`);
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
