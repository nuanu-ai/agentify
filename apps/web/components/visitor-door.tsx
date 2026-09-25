"use client";

import { useVisitor } from "../lib/visitor";
import styles from "./site-chrome.module.css";

/**
 * Who this browser is signed in as, and the way to stop being them.
 *
 * Drawn in the browser from the site's one session, so the page it sits on
 * stays the same page for everybody and may be cached as one. A browser that
 * runs no script sees the doors beside it and no address (ADR-0026 §3). The
 * sign-out is the cabinet's own same-origin form, which ends this browser's
 * session everywhere on the site and opens the sign-in with an empty field.
 * An operator also finds the dashboard here: the flag arrives on the same
 * answer as the address, and it is theirs to know (ADR-0026 §6).
 */
export function VisitorDoor() {
  const visitor = useVisitor();
  // Busy while the header is still finding out, which is what a screen reader
  // announces; the slot takes no room of its own in the row of doors.
  return (
    <span aria-busy={visitor.status === "loading"} className={styles.visitorSlot}>
      {visitor.status === "unknown" ? (
        <span className={styles.visitor}>We cannot tell who is visiting right now</span>
      ) : visitor.status === "signed_in" ? (
        <>
          {visitor.operator ? <a href="/admin">Admin</a> : null}
          <span className={styles.who} title={visitor.email}>
            {visitor.email}
          </span>
          <form action="/cabinet/sign-out" className={styles.signOut} method="post">
            <button type="submit">Sign out</button>
          </form>
        </>
      ) : null}
    </span>
  );
}
