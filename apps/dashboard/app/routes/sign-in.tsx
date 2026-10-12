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
import { answer, carried, useChrome } from "../answer.js";
import { AskScreen, LinkRequestedScreen, MailUnavailableScreen } from "../screens/sign-in.js";
import { services } from "../services.js";

export const headers = carried;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const pages = context.get(services);
  return answer(
    await pages.signIn.page(
      request.headers.get("cookie") ?? undefined,
      new URL(request.url).searchParams,
    ),
    request,
    context,
  );
}

export async function action({ request, context }: ActionFunctionArgs) {
  const pages = context.get(services);
  return answer(await pages.signIn.ask(await request.formData()), request, context);
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
      />
    );
  }
  if (view.screen === "unavailable") {
    return <MailUnavailableScreen chrome={chrome} />;
  }
  return <AskScreen chrome={chrome} view={view} />;
}
