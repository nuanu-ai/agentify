import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer } from "../answer.js";
import { Frame } from "../components/frame.js";
import { ReceiptsScreen } from "../screens/receipts.js";
import { services, signedIn } from "../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { context } = asked;
  return answer(await context.get(services).screens.receipts(context.get(signedIn)), asked);
}

export default function Receipts() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="receipts" title="Receipts">
      <ReceiptsScreen view={view} />
    </Frame>
  );
}
