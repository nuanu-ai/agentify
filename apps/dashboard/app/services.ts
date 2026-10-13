/**
 * What the process that mounts these pages hands every request, and what the
 * gate hands the pages behind it. The process and this build load this module
 * separately, and a context is found only under the very key it was set with,
 * so the server entry exports `services` for the process to set.
 */

import { createContext } from "react-router";
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

/** Set by the gate; read only by the pages nested under it in `routes.ts`. */
export const signedIn = createContext<Person>();
