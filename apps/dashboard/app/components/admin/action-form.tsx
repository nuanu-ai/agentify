/**
 * Every administrative action of the workspace is this form: a box for the
 * reason where the action asks for one, a box to tick that names what follows,
 * and a button that says exactly what happens. It posts with no script, and
 * its answer is the page in its new state; the form draws only what concerns
 * itself: the step that asks for a fresh sign-in in its place, a refusal in
 * one sentence under the button, or a lost answer said as unknown. The server
 * checks all of it again (`pressed` in `src/admin/action.ts`).
 */

import { Button, Field } from "@agentify/ui";
import type { ReactNode } from "react";
import type { ActionAnswer } from "../../../src/admin/action.js";
import { CONFIRM_FIELD, CONFIRMED, REASON_FIELD } from "../../../src/admin/fields.js";
import { LOST_ANSWER, NO_REASON, REASON_IS_KEPT } from "../../../src/admin/words.js";
import { PostForm } from "../post-form.js";
import { StepUp } from "./step-up.js";

export function ActionForm({
  action,
  title,
  button,
  consequence,
  reason = false,
  reasonWords = { label: "Reason", hint: REASON_IS_KEPT },
  fields = {},
  answer = null,
  secondary = false,
}: Readonly<{
  /** Where it posts, under the dashboard's prefix. */
  action: string;
  /** What is being decided, over the form, where the page does not already say it. */
  title?: ReactNode;
  /** The button's words: exactly what happens. */
  button: string;
  /** The box to tick: what follows from the press. */
  consequence: string;
  /** Every intervention asks for one; an admission does not. */
  reason?: boolean;
  /**
   * What the reason box is called, the sentence under it and the refusal of a
   * press without it, where somebody besides the operators reads it.
   */
  reasonWords?: Readonly<{ label: string; hint: string; missing?: string }>;
  /** What else the form carries, such as the record it acts on. */
  fields?: Readonly<Record<string, string>>;
  /** How this form's last press was answered, or null where it was not pressed. */
  answer?: ActionAnswer | null;
  secondary?: boolean;
}>) {
  if (answer?.kind === "step-up") {
    return (
      <div className="op-decide">
        <StepUp view={answer.stepUp} />
      </div>
    );
  }
  const said =
    answer?.kind === "refused"
      ? answer.said === NO_REASON
        ? (reasonWords.missing ?? NO_REASON)
        : answer.said
      : answer?.kind === "unknown"
        ? LOST_ANSWER
        : null;
  return (
    <PostForm action={action} document className="op-decide">
      {(pending) => (
        <>
          {title === undefined ? null : <b>{title}</b>}
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          {reason ? (
            <Field
              label={reasonWords.label}
              name={REASON_FIELD}
              rows={3}
              required
              hint={reasonWords.hint}
              autoComplete="off"
            />
          ) : null}
          <label className="check">
            <input type="checkbox" name={CONFIRM_FIELD} value={CONFIRMED} required />
            <span>{consequence}</span>
          </label>
          <div className="row">
            <Button variant={secondary ? "secondary" : "primary"} pending={pending}>
              {button}
            </Button>
          </div>
          {said === null ? null : (
            <p className="problem" role="alert">
              {said}
            </p>
          )}
        </>
      )}
    </PostForm>
  );
}
