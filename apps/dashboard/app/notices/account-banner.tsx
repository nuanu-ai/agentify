import { lazy } from "react";
import { Link, useLocation, useRouteError, useRouteLoaderData } from "react-router";
import type { AccountNote } from "../../src/account-banner.js";
import { headingOf } from "../../src/account-heading.js";
import type { FrameView } from "../../src/views.js";
import { Moment } from "../components/moment.js";
import styles from "./account-banner.module.css";
import { Notice } from "./notice.js";

const WalletChangeReason = lazy(() =>
  import("./wallet-change-note.js").then(({ WalletChangeReason }) => ({
    default: WalletChangeReason,
  })),
);

/**
 * A way to the documentation or to another site, which the dashboard's router
 * would put under its own mount point.
 */
const offTheDashboard = (to: string): boolean => /^(\/docs\/|[a-z]+:)/.test(to);

/** The page itself or one under it. */
const isOn = (here: string, page: string): boolean => here === page || here.startsWith(`${page}/`);

/** A reason's line, and the way to the page that puts it right unless that page is this one. */
function Reason({ note, here, back }: Readonly<{ note: AccountNote; here: string; back: string }>) {
  const { change } = note;
  if (change !== undefined) {
    return <WalletChangeReason change={change} here={here} back={back} says={note.says} />;
  }
  return (
    <>
      {note.says}
      {note.fix === null || isOn(here, note.fix.to) ? null : (
        <>
          {" "}
          {offTheDashboard(note.fix.to) ? (
            <a href={note.fix.to}>{note.fix.words}</a>
          ) : (
            <Link to={note.fix.to} prefetch="intent">
              {note.fix.words}
            </Link>
          )}
          .
        </>
      )}
    </>
  );
}

/**
 * The one banner over a dashboard page, drawn only where something about the
 * whole account is not as usual: a heading, then each reason in one line with
 * the way on from it. In a list of several, a reason's line opens with its own
 * title, unless the heading already says it. A way to the page it is drawn on
 * is left out, since the control it names is already on screen.
 */
export function AccountBanner({ notes: allNotes }: Readonly<{ notes: readonly AccountNote[] }>) {
  const { pathname: here, search } = useLocation();
  const back = `${here}${search}`;
  const onboarding = useRouteLoaderData<FrameView>("routes/merchant-only")?.onboarding;
  const routeError = useRouteError();
  const localDecision =
    here === "/products" &&
    routeError == null &&
    onboarding?.unread === false &&
    onboarding.account?.decision != null;
  const notes = localDecision
    ? allNotes.filter((note) => note.reason !== "not_approved")
    : allNotes;
  const first = notes[0];
  const decision = localDecision ? onboarding?.account?.decision : null;
  if (first === undefined && !decision) return null;
  const heading = decision
    ? (onboarding?.account?.heading ?? decision.noteLabel)
    : headingOf(notes);
  // A line that holds a form is no paragraph, which may hold none.
  const Line = first?.change === undefined ? "p" : "div";
  return (
    <Notice title={heading} label="About your account">
      {decision ? (
        <>
          <p>
            {decision.label}
            <Moment at={decision.at} />.
          </p>
          {decision.note === null ? null : (
            <>
              <p>{decision.noteLabel}</p>
              <p className={styles.decisionNote}>{decision.note}</p>
            </>
          )}
        </>
      ) : null}
      {first === undefined ? null : notes.length === 1 ? (
        <Line key={first.reason} data-reason={first.reason}>
          <Reason note={first} here={here} back={back} />
        </Line>
      ) : (
        <ul className={styles.reasons}>
          {notes.map((note) => (
            <li key={note.reason} data-reason={note.reason}>
              {note.title === heading ? null : `${note.title}. `}
              <Reason note={note} here={here} back={back} />
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
}
