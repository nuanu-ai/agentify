import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer } from "../answer.js";
import { Frame } from "../components/frame.js";
import { ReceiptsScreen } from "../screens/receipts.js";
import { services, signedIn } from "../services.js";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const pages = context.get(services);
  return answer(await pages.screens.receipts(context.get(signedIn)), request, context);
}

export default function Receipts() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="receipts" title="Receipts" frame={view.frame}>
      <ReceiptsScreen view={view} />
    </Frame>
  );
}
