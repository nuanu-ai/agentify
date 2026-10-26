/**
 * Every administrative action of the workspace is this form: a box for the
 * reason where the action asks for one, a box to tick that says what follows,
 * and a button that says exactly what happens, weighted by what it does: the
 * accent for the one action that helps a merchant sell, a plain button for an
 * intervention that can be undone, and the colour of a failure for one that
 * cannot. It posts with no script, and its answer is the page in its new
 * state. Where the page was read with a sign-in too old to act, the step that
 * asks for a fresh one stands in its place, before anything is typed; a press
 * refused for it, or for what it carried, draws the form again holding what
 * was typed. The server checks all of it again (`pressed` in
 * `src/admin/action.ts`).
 */

import { Field } from "@agentify/ui";
import type { ReactNode } from "react";
import type { ActionAnswer } from "../../../src/admin/action.js";
import { CONFIRM_FIELD, CONFIRMED, REASON_FIELD } from "../../../src/admin/fields.js";
import type { StepUpView } from "../../../src/admin/step-up.js";
import { NO_REASON, REASON_IS_KEPT } from "../../../src/admin/words.js";
import { PostForm } from "../post-form.js";
import { PressAnswer } from "./press-answer.js";
import { StepUp } from "./step-up.js";

/** What an action does to a merchant's selling, which sets its button's weight. */
export type ActionTone = "positive" | "plain" | "destructive";

const BUTTON: Readonly<Record<ActionTone, string>> = {
  positive: "button button-primary",
  plain: "button button-secondary",
  destructive: "button button-secondary op-destructive",
};

export function ActionForm({
  action,
  page,
  title,
  button,
  consequence,
  reason = false,
  reasonWords = { label: "Reason", hint: REASON_IS_KEPT },
  fields = {},
  answer = null,
  tone = "plain",
  stepUp = null,
  beside = null,
}: Readonly<{
  /** Where it posts, under the dashboard's prefix. */
  action: string;
  /** The page the form stands on, under the dashboard's prefix. */
  page: string;
  /** What is being decided, over the form, where the page does not already say it. */
  title?: ReactNode;
  /** The button's words: exactly what happens. */
  button: string;
  /** The box to tick: what follows from the press. */
  consequence: ReactNode;
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
  tone?: ActionTone;
  /** Where the page was read with a sign-in too old to act, the step that asks for a fresh one. */
  stepUp?: StepUpView | null;
  /** A fact to read before pressing, over the button. */
  beside?: ReactNode;
}>) {
  // Before any press, the step stands in the form's place; after one, over
  // the form, which keeps what was typed and the press's answer.
  if (stepUp !== null && answer === null) {
    return (
      <div className="op-decide">
        <StepUp view={stepUp} />
      </div>
    );
  }
  const askedFirst = answer?.kind === "step-up" ? answer.stepUp : stepUp;
  const typed = answer?.kind === "refused" || answer?.kind === "step-up" ? answer.typed : null;
  const refusedReason =
    answer?.kind === "refused" && answer.field === "reason"
      ? answer.said === NO_REASON
        ? (reasonWords.missing ?? NO_REASON)
        : answer.said
      : undefined;
  // A step-up stands over the form rather than in it: its own buttons are forms.
  const under = answer?.kind === "refused" || answer?.kind === "unknown" ? answer : null;
  return (
    <div className="op-decide">
      {askedFirst === null ? null : (
        <StepUp view={askedFirst} pressed={answer?.kind === "step-up"} />
      )}
      <PostForm action={action} document className="op-form">
        {(pending) => (
          <>
            {title === undefined ? null : <p className="op-form-title">{title}</p>}
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
                {...(typed === null ? {} : { defaultValue: typed })}
                {...(refusedReason === undefined ? {} : { error: refusedReason })}
              />
            ) : null}
            <label className="check">
              <input type="checkbox" name={CONFIRM_FIELD} value={CONFIRMED} required />
              <span>{consequence}</span>
            </label>
            {beside}
            <div className="row">
              <button
                className={BUTTON[tone]}
                type="submit"
                disabled={pending}
                aria-busy={pending ? true : undefined}
              >
                {button}
              </button>
            </div>
            {refusedReason === undefined ? (
              <PressAnswer answer={under} done="" page={page} />
            ) : null}
          </>
        )}
      </PostForm>
    </div>
  );
}

/**
 * An action that opens in place under the thing it acts on, opened already
 * where its press was refused or asked for a fresh sign-in, so the answer is
 * read beside the form that was pressed. Its words are in the colour of a
 * failure where the action cannot be undone.
 */
export function InPlace({
  summary,
  open,
  tone = "plain",
  children,
}: Readonly<{ summary: string; open: boolean; tone?: ActionTone; children: ReactNode }>) {
  return (
    <details className="op-in-place" open={open}>
      <summary className={tone === "destructive" ? "op-act op-act-destructive" : "op-act"}>
        {summary}
      </summary>
      {children}
    </details>
  );
}

/** Whether a disclosure holding a form opens on its answer: one that left the form to do again. */
export const opensOn = (answer: ActionAnswer | null): boolean =>
  answer !== null && answer.kind !== "done" && answer.kind !== "unchanged";
