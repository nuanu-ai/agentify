/**
 * The gate in front of every page that needs a session. The gate route in
 * `app/` asks this module and only turns its answer into a response, so who
 * gets in is decided here and nowhere else.
 */

import {
  adminDestinationIn,
  type DashboardDestination,
  type DashboardIdentity,
  type Person,
  sectionNamed,
} from "./dashboard-entry.js";

/**
 * Where a person who owns no merchant starts. The scanner knows whether they own
 * a report: it shows the latest, and sends somebody with none back to the
 * dashboard's screen with the one control that makes a merchant. Never that
 * screen for a person with reports, and never the merchant itself, which only
 * a request to the dashboard makes.
 */
const LATEST_REPORT = "/report/latest";

/** A merchant's owner starts on the dashboard, anybody else on the scanner. */
export const startOf = (base: string, person: Person): string =>
  person.merchant !== null ? `${base}/products` : LATEST_REPORT;

/**
 * Where a sign-in that opened leads `person`: the destination's page, except
 * that somebody with no merchant goes to the control that makes one instead of
 * a section about a merchant's selling. A page of the operator's workspace
 * needs no merchant, and its own check decides who it answers. A sign-in to
 * read reports goes where the dashboard's own address would.
 */
export const pathAfterSignIn = (
  base: string,
  person: Person,
  destination: DashboardDestination,
): string =>
  destination === "reports"
    ? startOf(base, person)
    : person.merchant === null && adminDestinationIn(destination) === null
      ? `${base}/merchant`
      : `${base}/${destination === "default" ? "products" : destination}`;

/**
 * Every cookie the sign-in component sets, not only the session, or the others
 * would stay for good. Each line carries the session's attributes, because a
 * browser replaces a cookie only with a line for the same path, and a `__Host-`
 * one only with a Secure line for the whole origin.
 */
export const clearingLines = (identity: DashboardIdentity, secure: boolean): readonly string[] =>
  identity.cookieNames.map(
    (name) =>
      `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`,
  );

interface GateQuestion {
  readonly cookie: string | undefined;
  readonly method: string;
  /** The path asked for, the dashboard's own prefix included. */
  readonly path: string;
  /** What a form that posts carries in `signed_in_as`; anything for a read. */
  readonly drawnFor: unknown;
}

type GateAnswer =
  /** Sent to the sign-in, which says why where it can, with the cookies cleared. */
  | Readonly<{ kind: "signed-out"; location: string; setCookies: readonly string[] }>
  /** A form drawn for an address that is not the one signed in now, or for none. */
  | Readonly<{
      kind: "not-drawn-for-you";
      who: string;
      start: string;
      setCookies: readonly string[];
    }>
  | Readonly<{
      kind: "signed-in";
      person: Person;
      /** Whether the account holds the operator flag, read with this very session. */
      operator: boolean;
      setCookies: readonly string[];
    }>;

export type Gate = (asked: GateQuestion) => Promise<GateAnswer>;

export function gateFor(base: string, identity: DashboardIdentity, cookieSecure: boolean): Gate {
  const carriesIdentityCookie = (header: string | undefined): boolean => {
    const pairs = (header ?? "").split(";");
    return identity.cookieNames.some((name) =>
      pairs.some((pair) => pair.split("=", 1)[0]?.trim() === name),
    );
  };

  return async ({ cookie, method, path, drawnFor }) => {
    const session = await identity.whoIs(cookie);
    const reading = method === "GET" || method === "HEAD";
    if (session === null) {
      // Cleared on the way out, so somebody whose session ended gets a usable
      // sign-in rather than this gate on every click.
      const reason = reading ? "session-ended" : "session-ended-unsaved";
      // Where the person was going (a bookmark, a screen a message links to, or
      // the section of an unsaved form) is carried through the sign-in so the
      // mailed link returns them there: a section of the dashboard, or a page
      // of the operator's workspace whole. An address outside them leads to
      // the start.
      const asked = path.slice(`${base}/`.length);
      const page = asked.split("/", 1)[0];
      const going =
        adminDestinationIn(asked) ?? adminDestinationIn(page) ?? sectionNamed(page) ?? "default";
      // A form sent without a cookie is told it was not kept.
      const query = [
        carriesIdentityCookie(cookie) ? `reason=${reason}` : reading ? "" : "reason=unsaved",
        going === "default" ? "" : `destination=${going}`,
      ]
        .filter((part) => part !== "")
        .join("&");
      return {
        kind: "signed-out",
        location: `${base}/sign-in${query === "" ? "" : `?${query}`}`,
        setCookies: clearingLines(identity, cookieSecure),
      };
    }
    // A form whose page was not drawn for this person is refused before
    // anything reads it: one drawn for another address, and one that carries no
    // mark at all. Refusing the unmarked one makes a missed form fail rather
    // than work for whoever is signed in.
    if (!reading && drawnFor !== session.person.email) {
      return {
        kind: "not-drawn-for-you",
        who: session.person.email,
        start: startOf(base, session.person),
        setCookies: session.setCookies,
      };
    }
    // Once a day the read moves the session's end, and the browser must be told
    // or its cookie expires thirty days after sign-in however often its person
    // returns.
    return {
      kind: "signed-in",
      person: session.person,
      operator: session.operator,
      setCookies: session.setCookies,
    };
  };
}
