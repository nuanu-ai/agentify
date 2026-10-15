/** A browser post starts Google's consent page; a failed start keeps the email door open. */

import { type ActionFunctionArgs, useActionData } from "react-router";
import { acted, carried, formOf, readsLeadTo, useChrome } from "../answer.js";
import { AskScreen } from "../screens/sign-in.js";
import { services } from "../services.js";

export const middleware = readsLeadTo("/sign-in");
export const headers = carried;

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return acted(
    async () => await context.get(services).signIn.googleStart(await formOf(request)),
    asked,
  );
}

export default function GoogleSignIn() {
  const chrome = useChrome();
  const view = useActionData<typeof action>();
  return view === undefined ? null : <AskScreen chrome={chrome} view={view} />;
}
