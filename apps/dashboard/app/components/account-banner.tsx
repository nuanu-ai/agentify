import { Link, useLocation } from "react-router";
import type { AccountNote } from "../../src/account-banner.js";
import type { AccountReason } from "../../src/words.js";

/**
 * The reasons whose own pages say them in their own words, so the banner
 * leaves them out there: the WooCommerce pages are about selling through the
 * shop.
 */
const SAID_ON_ITS_PAGES: ReadonlySet<AccountReason> = new Set(["through_shop"]);

/** The page itself or one under it, such as an import's answer under the shop's page. */
const isOn = (here: string, page: string): boolean => here === page || here.startsWith(`${page}/`);

/**
 * The one banner over a dashboard page, drawn only where something about the
 * whole account is not as usual: each reason a bold title, one sentence and,
 * where a page puts it right, the way there. A way to the page it is drawn on
 * is left out, since the control it names is already on screen, and so is a
 * reason that page says itself.
 */
export function AccountBanner({ notes }: Readonly<{ notes: readonly AccountNote[] }>) {
  const here = useLocation().pathname;
  const shown = notes.filter(
    (note) => !(SAID_ON_ITS_PAGES.has(note.reason) && note.fix !== null && isOn(here, note.fix.to)),
  );
  if (shown.length === 0) return null;
  return (
    <section className="account-banner" aria-label="About your account">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.5" />
      </svg>
      <div>
        {shown.map((note) => (
          <p key={note.reason} data-reason={note.reason}>
            <b>{note.title}</b> {note.says}
            {note.fix === null || isOn(here, note.fix.to) ? null : (
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
