/**
 * The pages in front of the gate. Asking for a link never says whether the
 * address is new or already belongs to a merchant. Opening the link only draws
 * a form; the token is spent by the press, so a mail preview cannot sign
 * anybody in.
 */

import { Button, Field } from "@agentify/ui";
import { useEffect, useState } from "react";
import { Form, useNavigation } from "react-router";
import type { DashboardDestination } from "../../src/dashboard-entry.js";
import type { LinkAnswer, OpenLinkView, SignInView } from "../../src/page-services.js";
import type { Chrome } from "../answer.js";
import googleMark from "../assets/google-g.svg";
import { GatePage } from "../components/gate-page.js";
import styles from "./sign-in.module.css";

const Destination = ({ destination }: Readonly<{ destination: DashboardDestination }>) =>
  destination === "default" ? null : <input type="hidden" name="destination" value={destination} />;

/**
 * The ad click a visitor arrived with, carried from form to form as the
 * destination is, so whichever way in is pressed keeps it.
 */
const Click = ({ clickId }: Readonly<{ clickId: string | undefined }>) =>
  clickId === undefined ? null : <input type="hidden" name="clickid" value={clickId} />;

/** The press is on its way while React Router sends a form here. */
const usePressed = (): boolean => useNavigation().state === "submitting";

type AskView = Extract<SignInView, { screen: "ask" }>;

/** Named by its words; the "G" beside them says nothing a screen reader needs. */
const GoogleButton = () => (
  <button className={`button button-secondary ${styles.google}`} type="submit">
    <img src={googleMark} alt="" width="20" height="20" />
    Sign in with Google
  </button>
);

export function AskScreen({ chrome, view }: Readonly<{ chrome: Chrome; view: AskView }>) {
  const pressed = usePressed();
  // A page that says why the person is here is about somebody who was signed
  // in, or about a refusal; only the plain page speaks to a newcomer.
  const plain = view.reason === undefined && view.problem === undefined;
  return (
    <GatePage chrome={chrome} title="Sign in">
      <div className={`gate-card ${styles.card}`}>
        <h1>Sign in</h1>
        {view.reason === undefined ? null : <p>{view.reason}</p>}
        <Form method="post" action="/sign-in">
          <Field
            label="Email address"
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            required
            defaultValue={view.email ?? ""}
            {...(view.problem === undefined
              ? { hint: "We email you a link. It works once, within an hour." }
              : { error: view.problem })}
          />
          <Destination destination={view.destination} />
          <Click clickId={view.clickId} />
          <Button pending={pressed}>Send me a sign-in link</Button>
        </Form>
        {view.googleEnabled ? (
          <>
            <p className={`or ${styles.or}`}>or</p>
            <Form method="post" action="/sign-in/google" reloadDocument>
              <Destination destination={view.destination} />
              <Click clickId={view.clickId} />
              <GoogleButton />
            </Form>
          </>
        ) : null}
        {/* The header's own Privacy link is hidden on a phone, and an ad's visitor is reported
            to the ad tracker with nothing asked here, so the privacy page is reached from
            the card. */}
        <p className={`quiet ${styles.foot}`}>
          {plain ? "New to Agentify? Signing in creates your account. " : null}
          <a href="/privacy">Privacy</a>
        </p>
      </div>
    </GatePage>
  );
}

/**
 * Below this the button counts seconds, above it whole minutes. Ninety seconds
 * is above every one-minute wait and below any hourly wait long enough to walk
 * away from.
 */
const SECONDS_WORTH_WATCHING = 90;

const counted = (amount: number, unit: string): string =>
  `${amount} ${unit}${amount === 1 ? "" : "s"}`;

/**
 * The words and the button show the same number and must round the same way,
 * or the page argues with itself.
 */
const waitInWords = (seconds: number): string =>
  seconds > SECONDS_WORTH_WATCHING
    ? counted(Math.ceil(seconds / 60), "minute")
    : counted(Math.max(1, Math.ceil(seconds)), "second");

/**
 * Served pressable, and taken away by the page's script for the wait, which it
 * then carries on its face: nothing can lift a `disabled` attribute where the
 * script did not run, and a button served disabled would be dead for the
 * person most in need of it. The wait is counted against a deadline, because a
 * background tab's timers are throttled and a tab that slept through the wait
 * must get the button back at once.
 */
function WaitingButton({
  seconds,
  pending,
  label,
}: Readonly<{ seconds: number; pending: boolean; label: string }>) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!(seconds > 0)) return;
    const until = Date.now() + seconds * 1000;
    const draw = (): boolean => {
      const remaining = Math.ceil((until - Date.now()) / 1000);
      setLeft(remaining > 0 ? remaining : null);
      return remaining > 0;
    };
    if (!draw()) return;
    const tick = setInterval(() => {
      if (!draw()) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [seconds]);
  return (
    <Button variant="secondary" disabled={left !== null} pending={pending} data-link-wait={seconds}>
      {left === null
        ? label
        : `${label} in ${left > SECONDS_WORTH_WATCHING ? `${Math.ceil(left / 60)} min` : `${left} s`}`}
    </Button>
  );
}

/**
 * Where the page's script runs, the button carries a refusal's wait; these
 * words carry it for a browser that runs none, whose button stays as served.
 */
const WaitWithoutScript = ({ seconds }: Readonly<{ seconds: number }>) => (
  <noscript>
    <p className="quiet">Try again in {waitInWords(seconds)}.</p>
  </noscript>
);

/** Why no link went out, where no other address would have fared better. */
const PAUSED: Readonly<Record<"client" | "shared" | "ceiling", string>> = {
  client: "Your connection has asked for too many sign-in links this hour.",
  shared:
    "Too many sign-in links were asked for this hour from connections we cannot tell apart from yours.",
  ceiling:
    "More sign-in links than usual were asked for this hour, so they are paused for everyone.",
};

/**
 * Never says whether the address is known. The resend is on every version of
 * the page: an accepted request cannot know the message arrived, and a refused
 * one must leave something to come back to; a refusal only changes whether it
 * can be pressed yet. A link that went out reads the same whether or not it
 * was the hour's last; the button shows the wait once there is one.
 *
 * The minute's page may say only what the rate row holds: not where the
 * earlier link leads, since it may have been asked for elsewhere, and not
 * delivery, since the provider's side is unknown here. It says a link went to
 * this address.
 *
 * A refusal by the client's, the shared or the channel's hour reads the same
 * for every address, so it cannot tell anybody which of them has an account.
 * Another address would be refused as well, so these offer Google instead of
 * a different address.
 */
export function LinkRequestedScreen({
  chrome,
  email,
  destination,
  answer,
  googleEnabled,
  clickId,
}: Readonly<{
  chrome: Chrome;
  email: string;
  destination: DashboardDestination;
  answer: LinkAnswer;
  googleEnabled: boolean;
  clickId?: string;
}>) {
  const pressed = usePressed();
  const wall = "wall" in answer ? answer.wall : null;
  const anyAddressRefused = wall === "client" || wall === "shared" || wall === "ceiling";
  const heading = anyAddressRefused ? "Sign-in links are paused" : "Check your email";
  const seconds = Math.max(0, Math.ceil(answer.seconds));
  return (
    <GatePage chrome={chrome} title={heading}>
      <div className={`gate-card ${styles.card}`}>
        <h1>{heading}</h1>
        {wall === null ? (
          <>
            <p>
              A sign-in link is on its way to <strong>{email}</strong>.
            </p>
            <p className="quiet">If nothing arrives in a minute, check your spam folder.</p>
          </>
        ) : wall === "interval" ? (
          <>
            <p>
              No new link was sent: one went to <strong>{email}</strong> less than a minute ago.
            </p>
            <p className="quiet">Check your inbox and your spam folder.</p>
          </>
        ) : wall === "hourly" ? (
          <>
            <p>
              No new link was sent: <strong>{email}</strong> has had its three links for this hour.
            </p>
            <WaitWithoutScript seconds={seconds} />
          </>
        ) : (
          <>
            <p>{PAUSED[wall]}</p>
            <WaitWithoutScript seconds={seconds} />
          </>
        )}
        <Form method="post" action="/sign-in">
          <input name="email" type="hidden" value={email} />
          <Destination destination={destination} />
          <Click clickId={clickId} />
          <WaitingButton seconds={seconds} pending={pressed} label="Send another link" />
        </Form>
        {anyAddressRefused ? (
          googleEnabled ? (
            <>
              <p className={`or ${styles.or}`}>or</p>
              <Form method="post" action="/sign-in/google" reloadDocument>
                <Destination destination={destination} />
                <Click clickId={clickId} />
                <GoogleButton />
              </Form>
            </>
          ) : null
        ) : (
          <Form className={styles.caption} method="get" action="/sign-in">
            <Destination destination={destination} />
            <Click clickId={clickId} />
            <button className={styles.textButton} type="submit">
              Use a different address
            </button>
          </Form>
        )}
      </div>
    </GatePage>
  );
}

/**
 * "Refused" covers both a provider that rejected the message and one that did
 * not answer in time, and the second may have delivered it. Nothing of the
 * attempt was kept, neither the link nor its count against the limits, so a
 * message that arrives anyway carries a link that no longer opens, and trying
 * again asks for a new one as if this attempt had not happened. Trying again
 * keeps the ad's click.
 */
export function MailUnavailableScreen({
  chrome,
  clickId,
}: Readonly<{ chrome: Chrome; clickId?: string }>) {
  return (
    <GatePage chrome={chrome} title="Your sign-in link may not have been sent">
      <Form className={`gate-card ${styles.card}`} method="get" action="/sign-in">
        <h1>Your sign-in link may not have been sent</h1>
        <p>
          Our email service did not confirm it. If the email arrives anyway, its link will not work,
          so ask for a new one.
        </p>
        <Click clickId={clickId} />
        <Button>Try again</Button>
      </Form>
    </GatePage>
  );
}

/**
 * Drawing it spends nothing; the press does. The address is shown because a
 * link for somebody else's address, sent to a victim, would otherwise sign them
 * in as that somebody without their noticing. The page runs no script, so the
 * form is posted by the browser itself.
 */
export function OpenLinkScreen({ chrome, view }: Readonly<{ chrome: Chrome; view: OpenLinkView }>) {
  if (view.screen === "refused") {
    // Drawn only for a browser with no live session, so it names nobody and
    // says nothing about whose the link was.
    return (
      <GatePage chrome={chrome} title="That link no longer works">
        <Form className={`gate-card ${styles.card}`} method="get" action="/sign-in" reloadDocument>
          <h1>That link no longer works</h1>
          <p>A sign-in link works once, within an hour.</p>
          <Button>Get a new link</Button>
        </Form>
      </GatePage>
    );
  }
  return (
    <GatePage chrome={chrome} title="Sign in">
      <Form
        className={`gate-card ${styles.card}`}
        method="post"
        action="/sign-in/open"
        reloadDocument
      >
        <h1>Sign in</h1>
        <input type="hidden" name="token" value={view.token} />
        <Button>Sign in as {view.email}</Button>
      </Form>
    </GatePage>
  );
}
