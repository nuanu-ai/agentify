/**
 * Who is visiting, asked from the browser, for the header and the report form.
 *
 * The page itself carries no address because a shared cache may keep it; only
 * `/api/v2/session`, which no shared cache stores, answers with one and passes
 * the renewed session cookie on. "Unknown" is a dashboard that did not answer,
 * kept apart from a stranger: not knowing who somebody is must not look like
 * knowing they are nobody.
 */

import { useEffect, useState } from "react";

export type Visitor =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "signed_in"; email: string; operator: boolean }>
  | Readonly<{ status: "signed_out" }>
  | Readonly<{ status: "unknown" }>;

/**
 * Checked by hand rather than by a schema, because this runs on every page and
 * a schema library in the browser costs each of them its weight. Only the
 * fields named here are kept.
 */
function visitorIn(answer: unknown): Visitor | null {
  if (typeof answer !== "object" || answer === null) return null;
  const said = answer as Record<string, unknown>;
  if (said.status === "signed_out") return { status: "signed_out" };
  if (
    said.status === "signed_in" &&
    typeof said.email === "string" &&
    said.email.length >= 3 &&
    typeof said.operator === "boolean"
  ) {
    return { status: "signed_in", email: said.email, operator: said.operator };
  }
  return null;
}

/**
 * Shared by every part of the page that asks at once, since two questions would
 * renew the session twice; cleared when it settles, so a later ask goes afresh.
 */
let inFlight: Promise<Visitor> | null = null;

export function askWhoIsVisiting(): Promise<Visitor> {
  inFlight ??= ask().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function ask(): Promise<Visitor> {
  try {
    const response = await fetch("/api/v2/session", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const visitor = visitorIn(await response.json().catch(() => null));
    if (!response.ok || visitor === null) return { status: "unknown" };
    return visitor;
  } catch {
    return { status: "unknown" };
  }
}

export function useVisitor(): Visitor {
  const [visitor, setVisitor] = useState<Visitor>({ status: "loading" });
  useEffect(() => {
    let current = true;
    void askWhoIsVisiting().then((answer) => {
      if (current) setVisitor(answer);
    });
    return () => {
      current = false;
    };
  }, []);
  return visitor;
}
