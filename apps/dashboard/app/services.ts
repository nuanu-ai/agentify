/**
 * What the process that mounts these pages hands every request, and what the
 * gate hands the pages behind it. The process and this build load this module
 * separately, and a context is found only under the very key it was set with,
 * so the server entry exports `services` for the process to set.
 */

import { createContext, type RouterContextProvider } from "react-router";
import type { Person } from "../src/dashboard-entry.js";
import type { Refusal } from "../src/form-post.js";
import type { PageServices } from "../src/page-services.js";

export const services = createContext<PageServices>();

/**
 * Set by the process for a post it refused before handing it over: decided
 * there because React Router's own origin check would answer an origin it
 * cannot parse first, with a bare line of its own.
 */
export const refused = createContext<Refusal | null>(null);

/**
 * Set by the process for a read a person's browser made to see a page: a GET
 * that is neither a prefetch nor the read of the page a press was just
 * answered on, which the press's script asks for at once.
 */
export const visit = createContext(false);

/** Set by the gate; read only by the pages nested under it in `routes.ts`. */
export const signedIn = createContext<Person>();

/**
 * Who the gate let through, or null for a page outside it or one the gate did
 * not let through: the gate's context has no default, so that a page under it
 * cannot read nobody.
 */
export const signedInOrNobody = (context: Readonly<RouterContextProvider>): Person | null => {
  try {
    return context.get(signedIn);
  } catch {
    return null;
  }
};
