import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../answer.js";
import { Frame } from "../components/frame.js";
import { readFailedIn } from "../components/not-loaded.js";
import { ReceiptsScreen } from "../screens/receipts.js";
import { services, signedIn } from "../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { context } = asked;
  return readOnly(
    async () => await context.get(services).screens.receipts(context.get(signedIn)),
    asked,
  );
}

export default function Receipts() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="receipts" title="Receipts">
      <ReceiptsScreen view={view} />
    </Frame>
  );
}

export const ErrorBoundary = readFailedIn({ tab: "receipts", title: "Receipts", what: "receipts" });
