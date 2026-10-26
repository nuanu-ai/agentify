import { Link, useLocation } from "react-router";
import { type AccountNote, headingOf } from "../../src/account-banner.js";
import styles from "./account-banner.module.css";

/** The page itself or one under it. */
const isOn = (here: string, page: string): boolean => here === page || here.startsWith(`${page}/`);

/** A reason's line, and the way to the page that puts it right unless that page is this one. */
function Reason({ note, here }: Readonly<{ note: AccountNote; here: string }>) {
  return (
    <>
      {note.says}
      {note.fix === null || isOn(here, note.fix.to) ? null : (
        <>
          {" "}
          <Link to={note.fix.to} prefetch="intent">
            {note.fix.words}
          </Link>
          .
        </>
      )}
    </>
  );
}

/**
 * The one banner over a dashboard page, drawn only where something about the
 * whole account is not as usual: a heading, then each reason in one line with
 * the way on from it. A way to the page it is drawn on is left out, since the
 * control it names is already on screen.
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
        <b>{headingOf(notes)}</b>
        {notes.length === 1 ? (
          notes.map((note) => (
            <p key={note.reason} data-reason={note.reason}>
              <Reason note={note} here={here} />
            </p>
          ))
        ) : (
          <ul className={styles.reasons}>
            {notes.map((note) => (
              <li key={note.reason} data-reason={note.reason}>
                <Reason note={note} here={here} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
