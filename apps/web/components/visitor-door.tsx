import { useVisitor } from "../lib/visitor";
import styles from "./site-chrome.module.css";

/**
 * Who this browser is signed in as, and the way to sign out.
 *
 * Drawn in the browser so the page it sits on stays the same for everybody and
 * may be cached as one; a browser that runs no script sees no address. The
 * sign-out is the dashboard's own same-origin form, which ends the session
 * everywhere on the site.
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
          <form action="/dashboard/sign-out" className={styles.signOut} method="post">
            <button type="submit">Sign out</button>
          </form>
        </>
      ) : null}
    </span>
  );
}
