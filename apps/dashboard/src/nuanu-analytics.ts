/**
 * Sends the product analytics events the gateway and the dashboard recorded
 * to Nuanu Analytics, one event per request and one request at a time.
 *
 * A turn is one transaction. It first gives up, unsent, every pending event
 * more than seven days old, because Nuanu dates an older one by its arrival,
 * and deletes every event that settled thirty days ago. Then it takes the
 * earliest due event, every other event before a screen viewed or a problem
 * shown, locked so no other sender takes it, and settles it: an
 * event about a person who opted out, or about the merchant their account
 * names, is suppressed; one that breaks the contract is dead, with the field
 * that broke it; any other is posted. A 200 sends it; a redirect, a 401, a 403
 * or a 404 says the configuration is wrong, so the event stays as it is and the
 * sender pauses; a 429, a 5xx, a timeout or a network failure tries it again
 * later. Every other answer, a 400 and a 413 among them, kills the event.
 *
 * Delivery is at least once: a process that stops after Nuanu answered and
 * before the commit leaves the event pending, and it is posted again with the
 * same id and time.
 *
 * Switched off, the loop sends nothing and still gives up and deletes on the
 * same terms.
 */

import { createHmac } from "node:crypto";
import { checkedEvent } from "@agentify/gateway/analytics";
import { failureNamed } from "@agentify/gateway/failure-named";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { DashboardConfig } from "./config.js";

type Target = NonNullable<DashboardConfig["nuanuAnalytics"]>;

const DEADLINE_MS = 5_000;
const IDLE_MS = 5_000;
/** Switched off, how often what the time left is settled. */
const TIDY_IDLE_MS = 60_000;
/** How long a refusal of the configuration holds every event back. */
const PAUSE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Nuanu dates an event older than this by its arrival. */
const OLDEST_MS = 7 * DAY_MS;
const KEPT_SETTLED_MS = 30 * DAY_MS;
/** The n-th failure waits the n-th of these, and every failure after them six hours. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
const LAST_RETRY_DELAY_MS = 6 * 60 * 60_000;
/** Hex digits of a reference: 128 bits, more than enough never to collide. */
const REFERENCE_LENGTH = 32;
const CONTRACT_VERSION = "commerce-v1";

/** Each reference an event can carry, and the property it is sent as. */
const REFERENCES = [
  ["merchant", "merchant_ref"],
  ["item", "item_ref"],
  ["order", "order_ref"],
  ["attempt", "attempt_ref"],
  ["operation", "operation_ref"],
] as const;

/**
 * What the server saw on a page rather than decided, which waits behind every
 * other event: a backlog of them never holds up a payment or an order.
 */
const OBSERVATIONS = ["agc_dashboard_viewed", "agc_ui_blocked"] as const;

/** Whose order of results a revision counts. */
const REVISED = new Set(["agc_payment_result", "agc_order_outcome_changed"]);

interface LoopParts {
  readonly pool: Pool;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
}

/** What the loop does after a turn: take the next event at once, wait a moment, or hold back. */
type Next = "next" | "idle" | "pause";

const span = (ms: number): SQL => sql`(${ms}::double precision * interval '1 millisecond')`;

/**
 * A reference as it leaves: the identifier hashed with the channel's key,
 * under a prefix per kind so one identifier of two kinds gives two references.
 */
const referenceOf = (key: string, kind: string, raw: string): string =>
  createHmac("sha256", key).update(`${kind}:${raw}`).digest("hex").slice(0, REFERENCE_LENGTH);

interface Due {
  readonly id: string;
  readonly sequence: string;
  readonly name: string;
  /** In ISO 8601, as the database writes a time into JSON. */
  readonly occurred_at: string;
  readonly actor_type: string;
  readonly source: string;
  readonly properties: unknown;
  readonly refs: unknown;
  readonly attempts: number;
  readonly opted_out: boolean;
}

/** The request Nuanu's tracking endpoint is sent for one event, as its own script sends one. */
function bodyOf(
  target: Target,
  due: Due,
  refs: Readonly<Record<string, string>>,
  fields: Readonly<Record<string, unknown>>,
): string {
  const references = Object.fromEntries(
    REFERENCES.flatMap(([kind, property]) => {
      const raw = refs[kind];
      return raw === undefined ? [] : [[property, referenceOf(target.referenceKey, kind, raw)]];
    }),
  );
  const properties = {
    contract_version: CONTRACT_VERSION,
    env: target.env,
    actor_type: due.actor_type,
    source: due.source,
    ...references,
    ...(REVISED.has(due.name) ? { revision: Number(due.sequence) } : {}),
    ...fields,
  };
  const person = refs.person;
  return JSON.stringify({
    type: "custom_event",
    site_id: target.siteId,
    event_name: due.name,
    event_id: due.id,
    timestamp: new Date(due.occurred_at).toISOString(),
    hostname: target.hostname,
    ...(target.internal ? { tag: "internal" } : {}),
    // Only a person is a user; an agent, a worker or the operator acting on
    // somebody's merchant is not that person's visit.
    ...(due.actor_type === "human" && person !== undefined
      ? { user_id: referenceOf(target.referenceKey, "person", person) }
      : {}),
    properties: JSON.stringify(properties),
  });
}

type Answer = Readonly<{ outcome: string; next: "sent" | "dead" | "retry" | "pause" }>;

async function posted(post: typeof fetch, target: Target, body: string): Promise<Answer> {
  try {
    const response = await post(target.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.apiKey}`,
        ...(target.ingestToken === null ? {} : { "x-nuanu-ingest-token": target.ingestToken }),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    // Nothing reads the body; cancelling it frees the connection.
    response.body?.cancel().catch(() => undefined);
    const { status } = response;
    const outcome = `http_${status}`;
    if (status === 200) return { outcome, next: "sent" };
    // A redirect is not followed, since it would carry the key to another
    // address; like a refused key, it means the configuration is wrong.
    if ((status >= 300 && status < 400) || status === 401 || status === 403 || status === 404) {
      return { outcome, next: "pause" };
    }
    if (status === 429 || status >= 500) return { outcome, next: "retry" };
    return { outcome, next: "dead" };
  } catch (thrown) {
    const name = thrown instanceof Error ? thrown.name : "";
    return {
      outcome: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error",
      next: "retry",
    };
  }
}

type Transaction = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

/**
 * Gives up what is too old to send and deletes what settled long enough ago.
 * A row another sender holds is skipped, and met again on a later turn.
 */
async function tidy(tx: Transaction, at: Date): Promise<Readonly<{ old: number; gone: number }>> {
  const old = await tx.execute(sql`
    update commerce_analytics_events
       set state = 'given_up', next_attempt_at = null, settled_at = ${at}::timestamptz,
           last_outcome = 'older_than_7_days'
     where id in (
       select id from commerce_analytics_events
        where state = 'pending' and occurred_at < ${at}::timestamptz - ${span(OLDEST_MS)}
          for update skip locked
     )
  `);
  const gone = await tx.execute(sql`
    delete from commerce_analytics_events
     where id in (
       select id from commerce_analytics_events
        where state <> 'pending' and settled_at <= ${at}::timestamptz - ${span(KEPT_SETTLED_MS)}
          for update skip locked
     )
  `);
  return { old: old.rowCount ?? 0, gone: gone.rowCount ?? 0 };
}

const counted = (count: number): string => (count === 1 ? "1 event" : `${count} events`);

const tellTidied = ({ old, gone }: Readonly<{ old: number; gone: number }>): void => {
  if (old > 0) {
    console.log(
      `[dashboard] ${counted(old)} more than 7 days old given up unsent to Nuanu Analytics`,
    );
  }
  if (gone > 0) console.log(`[dashboard] ${counted(gone)} settled 30 days ago deleted`);
};

/**
 * One turn. A failure of the database is thrown, and the transaction's
 * rollback leaves every row as it was.
 */
export async function deliverOnce(parts: LoopParts & Readonly<{ target: Target }>): Promise<Next> {
  const now = parts.now ?? (() => new Date());
  type Turn = Readonly<{ tidied: { old: number; gone: number }; said: string | null; next: Next }>;
  const turn = await drizzle(parts.pool).transaction(async (tx): Promise<Turn> => {
    const tidied = await tidy(tx, now());
    const [due] = (
      await tx.execute<Record<string, unknown>>(sql`
        select e.id, e.sequence::text as sequence, e.name,
               to_json(e.occurred_at) #>> '{}' as occurred_at, e.actor_type, e.source,
               e.properties, e.refs, e.attempts,
               exists (
                 select 1 from dashboard_accounts a
                  where a.analytics_opt_out
                    and (a.id = e.refs ->> 'person' or a.merchant_id = e.refs ->> 'merchant')
               ) as opted_out
          from commerce_analytics_events e
         where e.state = 'pending' and e.next_attempt_at <= ${now()}::timestamptz
         order by e.name in (${sql.join(
           OBSERVATIONS.map((name) => sql`${name}`),
           sql`, `,
         )}), e.next_attempt_at, e.sequence
         limit 1
           for update of e skip locked
      `)
    ).rows as unknown as Due[];
    if (due === undefined) return { tidied, said: null, next: "idle" };

    const theRow = sql`id = ${due.id}::uuid`;
    const settle = async (state: string, outcome: string, attempts = due.attempts) => {
      const at = now();
      await tx.execute(sql`
        update commerce_analytics_events
           set state = ${state}, attempts = ${attempts}, next_attempt_at = null,
               last_outcome = ${outcome}, settled_at = ${at}::timestamptz,
               sent_at = ${state === "sent" ? at : null}::timestamptz
         where ${theRow}
      `);
    };

    if (due.opted_out) {
      await settle("suppressed", "opted_out");
      return { tidied, said: `${due.name} suppressed: opted out`, next: "next" };
    }
    const checked = checkedEvent({
      name: due.name,
      actor: due.actor_type,
      source: due.source,
      refs: due.refs,
      fields: due.properties,
    });
    if ("problem" in checked) {
      await settle("dead", `invalid: ${checked.problem}`);
      return { tidied, said: `${due.name} dead: invalid: ${checked.problem}`, next: "next" };
    }

    const { outcome, next } = await posted(
      parts.fetch ?? fetch,
      parts.target,
      bodyOf(
        parts.target,
        due,
        (checked.event.refs ?? {}) as Readonly<Record<string, string>>,
        checked.event.fields ?? {},
      ),
    );
    const attempts = due.attempts + 1;
    if (next === "sent") {
      await settle("sent", outcome, attempts);
      return { tidied, said: null, next: "next" };
    }
    if (next === "dead") {
      await settle("dead", outcome, attempts);
      return { tidied, said: `${due.name} dead: ${outcome}`, next: "next" };
    }
    if (next === "pause") {
      await tx.execute(sql`
        update commerce_analytics_events set attempts = ${attempts}, last_outcome = ${outcome}
         where ${theRow}
      `);
      return {
        tidied,
        said:
          `Nuanu Analytics answered ${outcome}, which a problem of the configuration causes:` +
          " NUANU_ANALYTICS_SITE_ID, NUANU_ANALYTICS_API_KEY or NUANU_ANALYTICS_INGEST_TOKEN;" +
          ` sending pauses for ${PAUSE_MS / 60_000} minutes`,
        next: "pause",
      };
    }
    const nextAt = new Date(
      now().getTime() + (RETRY_DELAYS_MS[attempts - 1] ?? LAST_RETRY_DELAY_MS),
    );
    await tx.execute(sql`
      update commerce_analytics_events
         set attempts = ${attempts}, next_attempt_at = ${nextAt}::timestamptz,
             last_outcome = ${outcome}
       where ${theRow}
    `);
    // Nuanu in trouble is not asked about the next event at once.
    return { tidied, said: `${due.name} to be tried again: ${outcome}`, next: "idle" };
  });
  tellTidied(turn.tidied);
  if (turn.said !== null) console.log(`[dashboard] analytics event ${turn.said}`);
  return turn.next;
}

async function tidyOnce(parts: LoopParts): Promise<void> {
  const now = parts.now ?? (() => new Date());
  tellTidied(await drizzle(parts.pool).transaction(async (tx) => await tidy(tx, now())));
}

export interface NuanuAnalytics {
  /** Settles once the turn in flight has ended. */
  stop(): Promise<void>;
}

/**
 * Started on every dashboard: with a target it sends, and with none, where
 * analytics are switched off, it only gives up and deletes what the time
 * left. A turn that fails, such as one the database did not answer, is
 * logged and the loop goes on.
 */
export function startNuanuAnalytics(
  parts: LoopParts &
    Readonly<{
      target: Target | null;
      wait?: (ms: number) => Promise<void>;
    }>,
): NuanuAnalytics {
  const { target } = parts;
  const turn =
    target === null
      ? async (): Promise<Next> => {
          await tidyOnce(parts);
          return "idle";
        }
      : async (): Promise<Next> => await deliverOnce({ ...parts, target });
  let running = true;
  let wake: (() => void) | null = null;
  // Cut short by a stop, so the process does not wait out the pause.
  const idle = async (ms: number): Promise<void> => {
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
      let next: Next = "idle";
      try {
        next = await turn();
      } catch (thrown) {
        console.error(`[dashboard] an analytics turn failed: ${failureNamed(thrown)}`);
      }
      if (!running || next === "next") continue;
      await idle(next === "pause" ? PAUSE_MS : target === null ? TIDY_IDLE_MS : IDLE_MS);
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
