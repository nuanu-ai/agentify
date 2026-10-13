import { useVisitor } from "../lib/visitor";

/**
 * Who this browser is signed in as, and the way to sign out, for the site
 * header's doors.
 *
 * Drawn in the browser so the page it sits on stays the same for everybody and
 * may be cached as one; a browser that runs no script sees no address. The
 * sign-out is the dashboard's own same-origin form, which ends the session
 * everywhere on the site.
 */
export function VisitorDoor() {
  const visitor = useVisitor();
  // Busy while the header is still finding out, which is what a screen reader
  // announces.
  return (
    <span aria-busy={visitor.status === "loading"} className="site-visitor">
      {visitor.status === "unknown" ? (
        <span className="site-unknown">We cannot tell who is visiting right now</span>
      ) : visitor.status === "signed_in" ? (
        <>
          {visitor.operator ? <a href="/admin">Admin</a> : null}
          <span className="site-who" title={visitor.email}>
            {visitor.email}
          </span>
          <form action="/dashboard/sign-out" className="site-sign-out" method="post">
            <button type="submit">Sign out</button>
          </form>
        </>
      ) : null}
    </span>
  );
}
