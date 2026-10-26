/**
 * What a form post has to be before any page reads it: sent from the
 * dashboard's own host, and no longer than any form here sends.
 *
 * The origin is the second lock on a post. The forms include "stop all
 * selling" and the sign-in itself, and signing somebody into an attacker's
 * account is a way to read their work. `SameSite=Lax` is the main defence;
 * this is the second, because SameSite is scoped to the registrable domain, so
 * a page on `test.agentify.ad` is same-site with `agentify.ad`.
 *
 * A missing `Origin` is let through: browsers send it on every cross-origin form
 * post, and refusing its absence would turn away same-origin navigations and
 * command-line clients. Only the host is compared, never the scheme: a scheme
 * taken from `X-Forwarded-Proto` refuses every honest post behind a terminator
 * that does not set it, locking merchants out of the control that stops their
 * selling. An http page on the same host has no session to forge with anyway,
 * because the session cookie is `Secure` wherever the dashboard is on https.
 */

import { printable } from "./printable.js";

/** The largest form any page here posts, and more than any of them needs. */
const FORM_AT_MOST = 16 * 1024;

/**
 * Both sides are parsed rather than compared as text: a host header can carry a
 * port, an origin drops its scheme's default port, and an IPv6 literal is full
 * of colons. The port is left out on purpose, since a browser does not treat it
 * as a boundary. Anything unparseable, including the `null` a sandboxed
 * document sends, is not the same host.
 */
const sameHost = (origin: string, host: string): boolean => {
  const hostOf = (value: string): string | null => {
    try {
      return new URL(value).hostname || null;
    } catch {
      return null;
    }
  };
  // The host header is not a URL, so it is made into one; the scheme is
  // arbitrary and never compared.
  const here = hostOf(`http://${host}`);
  return here !== null && hostOf(origin) === here;
};

export const NOT_FROM_HERE = "This form came from another website, so it was ignored.";

/** Why a post is refused before it is read, in the words its page says. */
export type Refusal = Readonly<{ status: 403 | 413; said: string }>;

/** The headers a post's refusal is decided from, as they arrived; null lets it through. */
export const refusalOfPost = (
  sent: Readonly<{
    origin: string | undefined;
    host: string | undefined;
    length: string | undefined;
  }>,
): Refusal | null => {
  const { origin, host } = sent;
  if (origin !== undefined && (host === undefined || !sameHost(origin, host))) {
    // The page does not say which origin would have worked, an answer only to
    // somebody guessing. The log records what was compared, so an honest
    // browser refused can be told from an attacker; both values come from
    // outside and go through `printable`.
    console.log(
      `[dashboard] a form post was refused: its origin is ${printable(origin)},` +
        ` and it was addressed to ${printable(host ?? "nothing at all")}`,
    );
    return { status: 403, said: NOT_FROM_HERE };
  }
  // A body that does not say how long it is could be any length, and a page
  // reads a form whole.
  const length = Number(sent.length ?? Number.NaN);
  if (!(length <= FORM_AT_MOST)) {
    return { status: 413, said: "That was larger than any form on this page sends." };
  }
  return null;
};
