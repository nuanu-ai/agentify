/**
 * The four presses on an account, one address each under the account's page:
 * end every session, make an operator, remove the flag, forget the account.
 * The route's own address names the action, so a press can be nothing else.
 * Its answer is handed to the account's page, read after it, which draws it
 * beside the form that was pressed; a read of the address draws the page.
 */

import { type ActionFunctionArgs, createContext } from "react-router";
import type { AccountAct, AccountPressed } from "../../../src/admin/accounts.js";
import { acted, formOf } from "../../answer.js";
import { workspaceIn } from "../../services.js";

/** The press made on this request, which the account's page draws. */
export const accountPressed = createContext<AccountPressed | null>(null);

const ACTS: Readonly<Record<string, AccountAct>> = {
  "end-sessions": "end_sessions",
  "grant-operator": "grant_operator",
  "remove-operator": "remove_operator",
  forget: "forget_account",
};

const actOf = (url: URL): AccountAct | null => ACTS[url.pathname.split("/").at(-1) ?? ""] ?? null;

/**
 * A failure is drawn as the pages' own. A route with neither a page nor a
 * boundary is one React Router answers a failure from as bare text.
 */
export { ErrorBoundary } from "../../root.js";

export async function action(asked: ActionFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const act = actOf(asked.url);
  const form = await formOf(asked.request);
  return await acted(async () => {
    if (act === null) {
      return { kind: "problem", problem: { status: 404, said: "There is no such page." } };
    }
    const outcome = await admin.accounts.press(operator, asked.params.account_id ?? "", act, form);
    if (outcome.kind === "view") asked.context.set(accountPressed, outcome.view);
    return outcome;
  }, asked);
}

/**
 * The account's page around this route draws the press's answer; a route with
 * no component of its own would answer the press with data rather than a page.
 */
export default function Pressed() {
  return null;
}
