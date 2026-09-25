"use client";

/**
 * Who is visiting, asked from the browser, for the header and the report form.
 *
 * The page itself carries no address: it is what a shared cache may keep, and
 * the one answer carrying an address is `/api/v2/session`, which no shared
 * cache stores. That answer is also where the session's renewed cookie reaches
 * the browser (ADR-0026 §2, §3).
 *
 * Four states and not three. "Unknown" is a cabinet that did not answer, and it
 * is kept apart from a stranger on purpose: not knowing who somebody is must
 * not look like knowing they are nobody.
 */

import { useEffect, useState } from "react";
import { z } from "zod";

export type Visitor =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "signed_in"; email: string }>
  | Readonly<{ status: "signed_out" }>
  | Readonly<{ status: "unknown" }>;

const answerSchema = z.union([
  z.object({ status: z.literal("signed_in"), email: z.string().min(3) }),
  z.object({ status: z.literal("signed_out") }),
]);

/**
 * The question in flight, shared by every part of the page that asks it at
 * once: the header and the full-report form on a scan page want the same
 * answer, and two questions would renew the session twice in one moment. It
 * is forgotten when it settles, so a later part of the page asks afresh.
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
    const parsed = answerSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success) return { status: "unknown" };
    return parsed.data;
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
