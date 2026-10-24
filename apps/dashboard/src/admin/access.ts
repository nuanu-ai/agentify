/**
 * Who the operator's workspace answers, and when an operator may act.
 *
 * Every request to a page of the workspace reads the operator flag with the
 * session, after the gate has let a signed-in person through; anybody the flag
 * does not confirm, and everybody while the identity cannot answer, is given
 * the site's "no such page". An `Operator` is made only here, so a service of
 * the workspace that takes one cannot be called for somebody the flag did not
 * confirm on this request.
 *
 * An action asks more: a sign-in made in the last fifteen minutes. The moment
 * is the session's own (`LiveSession.signedInAt`), which a renewed session
 * keeps, so renewing a cookie never makes a sign-in fresh.
 */

import type { DashboardIdentity, Person } from "../dashboard-entry.js";

/** How recent a sign-in an administrative action asks for. */
export const FRESH_SIGN_IN_MS = 15 * 60 * 1000;

declare const confirmed: unique symbol;

/** A signed-in account the operator flag confirmed on this request. */
export type Operator = Readonly<{
  person: Person;
  /** When this session was signed in, by link or Google. */
  signedInAt: Date;
  readonly [confirmed]: true;
}>;

/**
 * The operator a request's session is, or null for anybody else: no session,
 * a session without the flag, or an identity that failed to answer. The
 * session is read without renewing it; the gate in front already renewed it
 * and passed the cookie on.
 */
export async function operatorOf(
  identity: DashboardIdentity,
  cookie: string | undefined,
): Promise<Operator | null> {
  try {
    const session = await identity.whoIs(cookie, { renew: false });
    if (session?.operator !== true) return null;
    return { person: session.person, signedInAt: session.signedInAt } as Operator;
  } catch {
    console.error(
      "[dashboard] the operator flag could not be read; the workspace answered as for nobody",
    );
    return null;
  }
}

/** Whether this operator signed in recently enough to act at `now`. */
export const signedInFreshly = (operator: Operator, now: Date): boolean =>
  now.getTime() - operator.signedInAt.getTime() < FRESH_SIGN_IN_MS;
