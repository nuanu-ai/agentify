import { Link, useLocation } from "react-router";
import type { AccountNote } from "../../src/account-banner.js";

/**
 * The one banner over a dashboard page, drawn only where something about the
 * whole account is not as usual: each reason a bold title, one sentence and,
 * where a page puts it right, the way there. A way to the page it is drawn on
 * is left out, since the control it names is already on screen.
 */
export function AccountBanner({ notes }: Readonly<{ notes: readonly AccountNote[] }>) {
  const here = useLocation().pathname;
  if (notes.length === 0) return null;
  return (
    <section className="account-banner" aria-label="About your account">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.5" />
      </svg>
      <div>
        {notes.map((note) => (
          <p key={note.reason} data-reason={note.reason}>
            <b>{note.title}</b> {note.says}
            {note.fix === null || note.fix.to === here ? null : (
              <>
                {" "}
                <Link to={note.fix.to} prefetch="intent">
                  {note.fix.words}
                </Link>
                .
              </>
            )}
          </p>
        ))}
      </div>
    </section>
  );
}
