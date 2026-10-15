/**
 * Asking for a sign-in link: the page, and the answer to the press, which is a
 * page rather than a redirect because it names the address the link went to.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
} from "react-router";
import { acted, answer, carried, formOf, useChrome } from "../answer.js";
import { AskScreen, LinkRequestedScreen, MailUnavailableScreen } from "../screens/sign-in.js";
import { services } from "../services.js";

export const headers = carried;
export const meta = () => [{ name: "robots", content: "noindex" }];

export async function loader(asked: LoaderFunctionArgs) {
  const { request, url, context } = asked;
  return answer(
    await context
      .get(services)
      .signIn.page(request.headers.get("cookie") ?? undefined, url.searchParams),
    asked,
  );
}

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return acted(async () => await context.get(services).signIn.ask(await formOf(request)), asked);
}

export default function SignIn() {
  const chrome = useChrome();
  const loaded = useLoaderData<typeof loader>();
  // The answer to a press, where there was one, is the page it is answered with.
  const view = useActionData<typeof action>() ?? loaded;
  if (view.screen === "requested") {
    return (
      <LinkRequestedScreen
        chrome={chrome}
        email={view.email}
        destination={view.destination}
        answer={view.answer}
        {...(view.click === undefined ? {} : { click: view.click })}
      />
    );
  }
  if (view.screen === "unavailable") {
    return (
      <MailUnavailableScreen
        chrome={chrome}
        {...(view.click === undefined ? {} : { click: view.click })}
      />
    );
  }
  return <AskScreen chrome={chrome} view={view} />;
}
