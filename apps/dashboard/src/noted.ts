import type { Person } from "./dashboard-entry.js";
import { printable } from "./printable.js";

/**
 * A process log, not an audit trail: it rotates, goes with the container, and
 * is written by the process it records. Never a one-time token, a link, a
 * session identifier or a merchant key.
 *
 * The whole line goes through `printable`, not only the field that first needed
 * it (a key's label, open to any alphabet and unbounded): a label with a
 * newline and a plausible sentence would forge a second line in the record of
 * who stopped the selling. Doing it here covers whatever is interpolated next.
 */
export const noted = (person: Person, did: string): void => {
  console.log(printable(`[dashboard] ${person.email} ${did}`));
};
