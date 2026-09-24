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
 */
export function VisitorDoor() {
  const visitor = useVisitor();
  if (visitor.status === "unknown")
    return <span className={styles.visitor}>We cannot tell who is visiting right now</span>;
  if (visitor.status !== "signed_in") return null;
  return (
    <>
      <span className={styles.who} title={visitor.email}>
        {visitor.email}
      </span>
      <form action="/cabinet/sign-out" className={styles.signOut} method="post">
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
