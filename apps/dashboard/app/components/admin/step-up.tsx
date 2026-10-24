/**
 * The step that asks an operator for a fresh sign-in, drawn where the action
 * is: a press made with an older sign-in changed nothing, and the operator
 * signs this browser in again, by a link mailed to their own address or by
 * their Google account, comes back to this page and presses again. No pop-up:
 * it reads the same on a phone and to a screen reader.
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

function LinkSaid({ link, email }: Readonly<{ link: StepUpLink; email: string }>) {
  if ("sent" in link) {
    return (
      <span>
        A link is on its way to {email}. Open it in this browser: it signs you in again and brings
        you back to this page, where you press again.
      </span>
    );
  }
  if ("wall" in link) {
    return (
      <span>
        A link was sent to {email} a short while ago. Open that one, or ask for another in{" "}
        {minutes(link.seconds)}.
      </span>
    );
  }
  return <span>The link could not be sent just now. Try again in a moment.</span>;
}

export function StepUp({ view }: Readonly<{ view: StepUpView }>) {
  return (
    <div className="op-stepup" role="alert">
      <b>Confirm it is you</b>
      <span>
        Actions ask for a sign-in from the last fifteen minutes; yours was made at{" "}
        <Moment at={view.signedInAt} />. Nothing has changed yet.
      </span>
      {view.link === null ? null : <LinkSaid link={view.link} email={view.email} />}
      <div className="row">
        {view.link !== null && "sent" in view.link ? null : (
          <PostForm action={SIGN_IN_AGAIN} document>
            {(pending) => (
              <>
                <input type="hidden" name="destination" value={view.destination} />
                <Button pending={pending} compact>
                  Email me a sign-in link
                </Button>
              </>
            )}
          </PostForm>
        )}
        {view.googleEnabled ? (
          <Form method="post" action="/sign-in/google" reloadDocument>
            <input type="hidden" name="destination" value={view.destination} />
            <button className="button button-secondary button-compact" type="submit">
              Continue with Google
            </button>
          </Form>
        ) : null}
      </div>
    </div>
  );
}
