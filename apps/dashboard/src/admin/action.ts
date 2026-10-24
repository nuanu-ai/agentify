/**
 * What every administrative press does before and after its own change, the
 * same for every action of the operator's workspace, so no action can skip a
 * step: a fresh sign-in, or the step that asks for one; the consequence box
 * ticked; a reason where the action asks for one; then the change, with its
 * journal row in the change's own transaction; and a lost answer said as
 * unknown. Every refusal after the operator flag confirmed who pressed is
 * written to the journal on its own; the flag's own refusal writes nothing,
 * since the workspace answers that person as it answers a page that is not
 * there.
 */

import {
  type JournalAction,
  type JournalEntry,
  type JournalPress,
  JournalReasonSchema,
  type JournalSubject,
} from "@agentify/gateway/journal";
import type { AdminDestination } from "../dashboard-entry.js";
import { type Operator, signedInFreshly } from "./access.js";
import { CONFIRM_FIELD, CONFIRMED, REASON_FIELD } from "./fields.js";
import { type StepUpView, stepUpViewOf } from "./step-up.js";
import { NO_REASON, NOT_CONFIRMED } from "./words.js";

/** How a press was answered, as the action form draws it. */
export type ActionAnswer =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; said: string }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "step-up"; stepUp: StepUpView }>;

/**
 * What an area's change answers: what the store settled its row as, or a
 * refusal of its own with the code the journal records and the sentence the
 * operator reads. A refusal changed nothing, and its row is written here.
 */
export type ChangeAnswer =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; code: string; said: string }>;

export interface Press {
  readonly operator: Operator;
  readonly form: FormData;
  readonly action: JournalAction;
  readonly subject: JournalSubject;
  /** Every intervention asks for a reason; an admission does not. */
  readonly needsReason: boolean;
  /** The page the press came from, which a fresh sign-in returns to. */
  readonly destination: AdminDestination;
}

export interface Pressing {
  readonly now: () => Date;
  readonly googleEnabled: boolean;
  /** Where a refused press is written, in a transaction of its own. */
  readonly refused: (entry: JournalEntry) => Promise<unknown>;
}

const once = (form: FormData, name: string): string | null => {
  const values = form.getAll(name);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : null;
};

/**
 * Runs one press. `change` makes the change and takes `journal` into its own
 * transaction (a store write's last argument, or `DashboardJournal.along`); it
 * is called only once every check passed, and a throw from it is a lost
 * answer: the change may have committed, so the press is answered as unknown.
 */
export async function pressed(
  press: Press,
  pressing: Pressing,
  change: (journal: JournalPress) => Promise<ChangeAnswer>,
): Promise<ActionAnswer> {
  const at = pressing.now();
  const base: JournalPress = {
    at: at.getTime(),
    actor: { kind: "account", id: press.operator.person.id },
    action: press.action,
    subject: press.subject,
    reason: null,
  };
  const refuse = async (code: string, said: string, reason: string | null = null) => {
    try {
      await pressing.refused({ ...base, reason, outcome: { kind: "refused", code } });
    } catch {
      // The press changed nothing either way; the refusal stands without its row.
      console.error("[dashboard] a refused administrative press could not be journaled");
    }
    return { kind: "refused", said } as const;
  };

  if (!signedInFreshly(press.operator, at)) {
    await refuse("sign_in_not_fresh", "");
    return {
      kind: "step-up",
      stepUp: stepUpViewOf(press.operator, press.destination, pressing.googleEnabled),
    };
  }
  if (once(press.form, CONFIRM_FIELD) !== CONFIRMED) {
    return await refuse("not_confirmed", NOT_CONFIRMED);
  }
  let reason: string | null = null;
  if (press.needsReason) {
    const typed = (once(press.form, REASON_FIELD) ?? "").trim();
    if (typed === "") return await refuse("no_reason", NO_REASON);
    const checked = JournalReasonSchema.safeParse(typed);
    if (!checked.success) {
      const said = checked.error.issues[0]?.message ?? "that reason cannot be kept";
      return await refuse(
        "reason_refused",
        `${said.slice(0, 1).toUpperCase()}${said.slice(1)}. Nothing was changed.`,
      );
    }
    reason = typed;
  }

  let answered: ChangeAnswer;
  try {
    answered = await change({ ...base, reason });
  } catch {
    console.error("[dashboard] an administrative press was not answered");
    return { kind: "unknown" };
  }
  if (answered.kind === "refused") return await refuse(answered.code, answered.said, reason);
  return answered;
}
