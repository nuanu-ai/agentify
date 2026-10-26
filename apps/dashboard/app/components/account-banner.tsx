import { Button } from "@agentify/ui";
import { Link, useLocation } from "react-router";
import type { AccountNote, WalletChangeNote } from "../../src/account-banner.js";
import { headingOf } from "../../src/words.js";
import { Address } from "../wallet/address.js";
import styles from "./account-banner.module.css";
import { Moment } from "./moment.js";
import { PostForm } from "./post-form.js";

/** The page itself or one under it. */
const isOn = (here: string, page: string): boolean => here === page || here.startsWith(`${page}/`);

/**
 * The cancel, pressed from whichever page the banner is on and brought back to
 * it. It carries the change it showed, as the settings' own cancel does. On
 * Settings the wallet's section holds the cancel, so the banner has none.
 */
function CancelChange({ change, back }: Readonly<{ change: WalletChangeNote; back: string }>) {
  return (
    <PostForm document action="/settings/payout-wallet/cancel" className={styles.cancel}>
      {(pressed) => (
        <>
          <input type="hidden" name="waiting" value={change.wallet} />
          <input type="hidden" name="waiting_from" value={change.takesEffectAt} />
          <input type="hidden" name="paid" value={change.paid ?? ""} />
          <input type="hidden" name="back" value={back} />
          <Button variant="secondary" compact pending={pressed}>
            Cancel this change
          </Button>
        </>
      )}
    </PostForm>
  );
}

/** A reason's line, and the way to the page that puts it right unless that page is this one. */
function Reason({ note, here, back }: Readonly<{ note: AccountNote; here: string; back: string }>) {
  const { change } = note;
  if (change !== undefined) {
    return (
      <>
        From <Moment at={change.from} />, your share of each sale goes to{" "}
        <Address address={change.wallet} />. {note.says}
        {isOn(here, "/settings") ? null : <CancelChange change={change} back={back} />}
      </>
    );
  }
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
  const { pathname: here, search } = useLocation();
  const back = `${here}${search}`;
  if (notes.length === 0) return null;
  return (
    <section className="account-banner" aria-label="About your account">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.5" />
      </svg>
      <div>
        <b className={styles.heading}>{headingOf(notes)}</b>
        {notes.length === 1 ? (
          notes.map((note) =>
            // A line that holds a form is no paragraph, which may hold none.
            note.change === undefined ? (
              <p key={note.reason} data-reason={note.reason}>
                <Reason note={note} here={here} back={back} />
              </p>
            ) : (
              <div key={note.reason} data-reason={note.reason}>
                <Reason note={note} here={here} back={back} />
              </div>
            ),
          )
        ) : (
          <ul className={styles.reasons}>
            {notes.map((note) => (
              <li key={note.reason} data-reason={note.reason}>
                <Reason note={note} here={here} back={back} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
