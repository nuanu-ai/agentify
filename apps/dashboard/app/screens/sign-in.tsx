/**
 * The pages in front of the gate. Asking for a link never says whether the
 * address is new or already belongs to a merchant. Opening the link only draws
 * a form; the token is spent by the press, so a mail preview cannot sign
 * anybody in.
 */

import { Button, Field } from "@agentify/ui";
import { useEffect, useState } from "react";
import { Form, useNavigation } from "react-router";
import { ADS_CONSENT } from "../../src/ads-consent.js";
import type { DashboardDestination } from "../../src/dashboard-entry.js";
import type {
  LinkAnswer,
  OfferedClick,
  OpenLinkView,
  SignInView,
} from "../../src/page-services.js";
import type { Chrome } from "../answer.js";
import { GatePage } from "../components/gate-page.js";

const Destination = ({ destination }: Readonly<{ destination: DashboardDestination }>) =>
  destination === "default" ? null : <input type="hidden" name="destination" value={destination} />;

/**
 * The ad click a visitor arrived with, carried from form to form as the
 * destination is. Never the consent: only the box drawn beside a button
 * carries that.
 */
const Click = ({ click }: Readonly<{ click: OfferedClick | undefined }>) =>
  click === undefined ? null : <input type="hidden" name="clickid" value={click.id} />;

/**
 * Unticked unless the person ticked it on the press this page answers; the
 * sentence is the box's label, so pressing the words ticks it too. The way to
 * the privacy page stays outside the label, or it would become part of the
 * box's name.
 */
const ConsentBox = ({ click }: Readonly<{ click: OfferedClick | undefined }>) =>
  click === undefined ? null : (
    <div className="consent">
      <label>
        <input type="checkbox" name="ads_consent" value="yes" defaultChecked={click.consented} />
        <span>{ADS_CONSENT.sentence}</span>
      </label>
      <a href={ADS_CONSENT.explained.href}>{ADS_CONSENT.explained.words}</a>
    </div>
  );

/** The press is on its way while React Router sends a form here. */
const usePressed = (): boolean => useNavigation().state === "submitting";

export function AskScreen({
  chrome,
  view,
}: Readonly<{ chrome: Chrome; view: Extract<SignInView, { screen: "ask" }> }>) {
  const pressed = usePressed();
  return (
    <GatePage chrome={chrome} title="Sign in">
      <Form className="gate-card" method="post" action="/sign-in">
        <h1>Sign in</h1>
        {view.reason === undefined ? null : <p>{view.reason}</p>}
        <p>Enter your email address and we will send you a sign-in link.</p>
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
          {...(view.problem === undefined ? {} : { error: view.problem })}
        />
        <Destination destination={view.destination} />
        <Click click={view.click} />
        <ConsentBox click={view.click} />
        <Button pending={pressed}>Send me a sign-in link</Button>
        <p className="quiet">
          Every sign-in gets its own link. It opens once and expires an hour after it is sent, so
          there is nothing to keep and no password to remember.
        </p>
        <p className="quiet">
          New to Agentify? Use this same form. Once the link signs you in, one button opens your
          seller dashboard.
        </p>
      </Form>
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
 * The sentence and the button show the same number and must round the same
 * way, or the page argues with itself.
 */
const waitInWords = (seconds: number): string =>
  seconds > SECONDS_WORTH_WATCHING
    ? counted(Math.ceil(seconds / 60), "minute")
    : counted(Math.max(1, Math.ceil(seconds)), "second");

/**
 * Served pressable, and taken away by the page's script for the wait: nothing
 * can lift a `disabled` attribute where the script did not run, and a button
 * served disabled would be dead for the person most in need of it. The wait is
 * counted against a deadline, because a background tab's timers are throttled
 * and a tab that slept through the wait must get the button back at once.
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
        : `${label} (${left > SECONDS_WORTH_WATCHING ? `${Math.ceil(left / 60)} min` : `${left} s`})`}
    </Button>
  );
}

/**
 * Never says whether the address is known. The resend is on every version of
 * the page: an accepted request cannot know the message arrived, and a refused
 * one must leave something to come back to; a refusal only changes whether it
 * can be pressed yet. Only the hourly page prints its wait in words, because a
 * person leaves the page for it.
 *
 * The minute's page may say only what the rate row holds: not where the
 * earlier link leads, since it may have been asked for elsewhere, and not
 * delivery, since the provider's side is unknown here. It says a link went to
 * this address.
 */
export function LinkRequestedScreen({
  chrome,
  email,
  destination,
  answer,
  click,
}: Readonly<{
  chrome: Chrome;
  email: string;
  destination: DashboardDestination;
  answer: LinkAnswer;
  click?: OfferedClick;
}>) {
  const pressed = usePressed();
  const wall = "wall" in answer ? answer.wall : null;
  const heading = wall === "hourly" ? "Try again later" : "Check your mail";
  return (
    <GatePage chrome={chrome} title={heading}>
      <div className="gate-card">
        <h1>{heading}</h1>
        {wall === null ? (
          <>
            <p>
              A sign-in link is on its way to <strong>{email}</strong>. It opens once and expires an
              hour after it is sent.
            </p>
            <p className="quiet">
              {
                // A wait longer than the counted seconds can only be the hourly
                // limit, so inviting another send would mean most of an hour's
                // wait.
                answer.seconds > SECONDS_WORTH_WATCHING
                  ? "If nothing has arrived in a minute, look in your spam folder. That was the last of this address's three links for the hour, so the next one waits for the hour to turn over."
                  : "If nothing has arrived in a minute, look in your spam folder, then send another link from this page."
              }
            </p>
          </>
        ) : wall === "interval" ? (
          <>
            <p>
              No new link was sent to <strong>{email}</strong>. A sign-in link went to this address
              less than a minute ago.
            </p>
            <p className="quiet">
              Look for it in your inbox and your spam folder. The link opens wherever it was
              requested, which may not be this page. One address gets one link a minute, so you can
              ask for another as soon as the minute is up.
            </p>
          </>
        ) : (
          <>
            <p>
              No new link was sent to <strong>{email}</strong>. One email address gets three links
              an hour, and this one has had its three.
            </p>
            <p className="problem">Try again in {waitInWords(answer.seconds)}.</p>
          </>
        )}
        <Form method="post" action="/sign-in">
          <input name="email" type="hidden" value={email} />
          <Destination destination={destination} />
          {/* Another link is asked for with what this page shows: the box,
              ticked as the person left it on the page before. */}
          <Click click={click} />
          <ConsentBox click={click} />
          <WaitingButton
            seconds={Math.max(0, Math.ceil(answer.seconds))}
            pending={pressed}
            label="Send another link"
          />
        </Form>
        <Form method="get" action="/sign-in">
          <Destination destination={destination} />
          <Click click={click} />
          <Button variant="secondary">Use a different address</Button>
        </Form>
      </div>
    </GatePage>
  );
}

/**
 * "Refused" covers both a provider that rejected the message and one that did
 * not answer in time, and the second may have delivered it. What is known is
 * that the send cannot be confirmed and nothing was written. Trying again
 * keeps the ad's click, so the box is offered again, unticked.
 */
export function MailUnavailableScreen({
  chrome,
  click,
}: Readonly<{ chrome: Chrome; click?: OfferedClick }>) {
  return (
    <GatePage chrome={chrome} title="We could not confirm your sign-in link went out">
      <Form className="gate-card" method="get" action="/sign-in">
        <h1>We could not confirm your sign-in link went out</h1>
        <p>
          Something went wrong while sending the email, so we do not know whether it was delivered.
          No account or session was created. Try again, and check that the email address is correct.
        </p>
        <Click click={click} />
        <Button>Try again</Button>
      </Form>
    </GatePage>
  );
}

/**
 * Drawing it spends nothing; the press does. The address is shown because a
 * link for somebody else's address, sent to a victim, would otherwise sign them
 * in as that somebody without their noticing. The page runs no script, so the
 * form is posted by the browser itself, with the name of the button pressed.
 *
 * Where the press would tell the ad tracker of the sign-up, the page says so
 * and offers a second button that signs in without it: anybody can ask for a
 * link for any address, so the box ticked then is not the owner's word.
 */
export function OpenLinkScreen({ chrome, view }: Readonly<{ chrome: Chrome; view: OpenLinkView }>) {
  if (view.screen === "refused") {
    // Drawn only for a browser with no live session, so it names nobody and
    // says nothing about whose the link was.
    return (
      <GatePage chrome={chrome} title="That link no longer works">
        <div className="gate-card">
          <h1>That link no longer works</h1>
          <p>
            A sign-in link opens once and expires an hour after it is sent. This one no longer opens
            anything.
          </p>
          <p>
            Nothing is lost: access belongs to your email address, not to any one link. Ask for a
            new one.
          </p>
          <Form method="get" action="/sign-in" reloadDocument>
            <Button variant="secondary">Ask for another link</Button>
          </Form>
        </div>
      </GatePage>
    );
  }
  return (
    <GatePage chrome={chrome} title="Sign in">
      <Form className="gate-card" method="post" action="/sign-in/open" reloadDocument>
        <h1>Sign in</h1>
        <p>
          This link signs <strong>{view.email}</strong> in on this browser.
        </p>
        {view.tellsTracker ? (
          <p>
            {ADS_CONSENT.confirmation}{" "}
            <a href={ADS_CONSENT.explained.href}>{ADS_CONSENT.explained.words}</a>
          </p>
        ) : null}
        <input type="hidden" name="token" value={view.token} />
        {view.tellsTracker ? (
          <>
            <Button name="report" value="yes">
              Sign in as {view.email}
            </Button>
            <Button variant="secondary" name="report" value="no">
              {ADS_CONSENT.without}
            </Button>
          </>
        ) : (
          <Button>Sign in as {view.email}</Button>
        )}
        <p className="quiet">
          If that is not your address, close this page. Nothing happens unless{" "}
          {view.tellsTracker ? "a" : "the"} button is pressed.
        </p>
      </Form>
    </GatePage>
  );
}
