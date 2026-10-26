/**
 * The step that asks an operator for a fresh sign-in, drawn where the action
 * is: in place of the action's form where the page was read with a sign-in
 * older than fifteen minutes, so nothing is typed into a form the press would
 * refuse; and over the form, which keeps what was typed, where a press was
 * refused for it. The operator signs this browser in again by a link mailed
 * to their own address or by their Google account, comes back to the page and
 * presses. No pop-up: it reads the same on a phone and to a screen reader.
 */

import { Button } from "@agentify/ui";
import { Form } from "react-router";
import type { StepUpLink, StepUpView } from "../../../src/admin/step-up.js";
import { Moment } from "../moment.js";
import { PostForm } from "../post-form.js";

/** Where the step's link press posts; it lives under the workspace's layout. */
const SIGN_IN_AGAIN = "/admin/sign-in-again";

const minutes = (seconds: number): string => {
  const whole = Math.ceil(seconds / 60);
  return whole <= 1 ? "a minute" : `${whole} minutes`;
};

/** What became of the link the operator asked for. */
export function LinkSaid({ link, email }: Readonly<{ link: StepUpLink; email: string }>) {
  if ("sent" in link) {
    return (
      <>
        A link is on its way to {email}. Open it in this browser: it signs you in again and brings
        you back to the page, where you press again.
      </>
    );
  }
  if ("wall" in link) {
    return (
      <>
        A link went to {email} a moment ago. Open that one, or ask for another in{" "}
        {minutes(link.seconds)}.
      </>
    );
  }
  return <>The link could not be sent just now. Try again in a moment.</>;
}

/**
 * The two ways to sign in again: a mailed link, offered while none is on its
 * way and held back while the last one is too recent, and Google, put first
 * where the mail did not go.
 */
export function SignInWays({ view }: Readonly<{ view: StepUpView }>) {
  const { link } = view;
  const mailed =
    link !== null && "sent" in link ? null : (
      <PostForm key="mail" action={SIGN_IN_AGAIN} document>
        {(pending) => (
          <>
            <input type="hidden" name="destination" value={view.destination} />
            <Button pending={pending} compact disabled={link !== null && "wall" in link}>
              Email me a sign-in link
            </Button>
          </>
        )}
      </PostForm>
    );
  const google = view.googleEnabled ? (
    <Form key="google" method="post" action="/sign-in/google" reloadDocument>
      <input type="hidden" name="destination" value={view.destination} />
      <button className="button button-secondary button-compact" type="submit">
        Continue with Google
      </button>
    </Form>
  ) : null;
  if (mailed === null && google === null) return null;
  return (
    <div className="message-actions">
      {link !== null && "unavailable" in link ? [google, mailed] : [mailed, google]}
    </div>
  );
}

export function StepUp({
  view,
  pressed = false,
}: Readonly<{
  view: StepUpView;
  /** Drawn because a press was refused for it, rather than before one. */
  pressed?: boolean;
}>) {
  return (
    <div className="callout op-stepup" role={pressed ? "alert" : undefined}>
      <p className="what">Sign in again to act</p>
      <p className="why">
        {pressed ? "Nothing was changed. " : null}
        Actions need a sign-in from the last 15 minutes; yours was at{" "}
        <Moment at={view.signedInAt} />.
      </p>
      {view.link === null ? null : (
        <p className="why">
          <LinkSaid link={view.link} email={view.email} />
        </p>
      )}
      <SignInWays view={view} />
    </div>
  );
}
