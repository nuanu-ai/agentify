import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { answer, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { IntegrationsScreen } from "../screens/integrations.js";
import { services, signedIn } from "../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { context } = asked;
  return answer(await context.get(services).integrations.page(context.get(signedIn)), asked);
}

export default function Integrations() {
  const view = useLoaderData<typeof loader>();
  return (
    <Frame tab="integrations" title="Integrations" frame={view.frame}>
      <IntegrationsScreen view={view} base={useChrome().base} />
    </Frame>
  );
}
