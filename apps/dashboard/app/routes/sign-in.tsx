/**
 * Asking for a sign-in link: the page, and the answer to the press, which is a
 * page rather than a redirect because it names the address the link went to.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { clientAddressOf } from "../../src/client-address.js";
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

/**
 * Not read again after its own press, whose answer is the page drawn; a read
 * after it would be a second visit to the page that nobody made.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  defaultShouldRevalidate,
}) => formMethod?.toUpperCase() !== "POST" && defaultShouldRevalidate;

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  const client = clientAddressOf(request.headers.get("x-forwarded-for"));
  return acted(
    async () => await context.get(services).signIn.ask(await formOf(request), client),
    asked,
  );
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
        googleEnabled={view.googleEnabled}
        {...(view.clickId === undefined ? {} : { clickId: view.clickId })}
      />
    );
  }
  if (view.screen === "unavailable") {
    return (
      <MailUnavailableScreen
        chrome={chrome}
        {...(view.clickId === undefined ? {} : { clickId: view.clickId })}
      />
    );
  }
  return <AskScreen chrome={chrome} view={view} />;
}
