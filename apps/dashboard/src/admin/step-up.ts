/**
 * The step that asks an operator for a fresh sign-in before an action. A press
 * without one changes nothing and draws this step where the action is; the
 * operator asks for a link mailed to their own address, or uses Google, and
 * either signs this browser in again and returns it to the page the press
 * came from, where they press again. Nothing is kept of the press: a link
 * carries no action, so a link opened by somebody else does nothing but sign
 * in the browser it is opened in.
 */

import type { AdminDestination, DashboardIdentity, LinkWall } from "../dashboard-entry.js";
import { adminDestinationIn } from "../dashboard-entry.js";
import type { Outcome } from "../page-services.js";
import { type MomentView, momentView } from "../views.js";
import type { Operator } from "./access.js";

/** What became of the link the operator asked for. */
export type StepUpLink =
  | Readonly<{ sent: true; seconds: number }>
  | Readonly<{ wall: LinkWall; seconds: number }>
  | Readonly<{ unavailable: true }>;

export interface StepUpView {
  /** The operator's own address, the only one a step-up link goes to. */
  readonly email: string;
  /** When this session was signed in, as the page prints a moment. */
  readonly signedInAt: MomentView;
  /** The page the sign-in returns to. */
  readonly destination: AdminDestination;
  readonly googleEnabled: boolean;
  /** Null until the operator asks for a link. */
  readonly link: StepUpLink | null;
}

export const stepUpViewOf = (
  operator: Operator,
  destination: AdminDestination,
  googleEnabled: boolean,
  link: StepUpLink | null = null,
): StepUpView => ({
  email: operator.person.email,
  signedInAt: momentView(operator.signedInAt.toISOString()),
  destination,
  googleEnabled,
  link,
});

/** The press that asks for the link, and the page that answers it. */
export interface SignInAgainPages {
  press(operator: Operator, form: FormData): Promise<Outcome<StepUpView>>;
}

export function signInAgainFor(identity: DashboardIdentity, now: () => Date): SignInAgainPages {
  return {
    async press(operator, form) {
      const named = form.getAll("destination");
      const destination = named.length === 1 ? adminDestinationIn(named[0]) : null;
      if (destination === null) {
        return {
          kind: "problem",
          problem: { status: 400, said: "There is no such page of the workspace to come back to." },
        };
      }
      const asked = await identity.requestStepUpLink(operator.person.email, destination);
      const seconds = (at: Date) =>
        Math.max(1, Math.ceil((at.getTime() - now().getTime()) / 1_000));
      const link: StepUpLink =
        asked.status === "unavailable"
          ? { unavailable: true }
          : asked.status === "cooldown"
            ? { wall: asked.wall, seconds: seconds(asked.retryAt) }
            : { sent: true, seconds: seconds(asked.retryAt) };
      const view = stepUpViewOf(operator, destination, identity.googleEnabled, link);
      if ("wall" in link) {
        return {
          kind: "view",
          status: 429,
          headers: { "retry-after": String(link.seconds) },
          view,
        };
      }
      return { kind: "view", status: "sent" in link ? 202 : 503, view };
    },
  };
}
