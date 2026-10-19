import {
  type ActionFunctionArgs,
  createContext,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { acted, answer, formOf, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { WooRecoveryScreen } from "../screens/woocommerce-recovery.js";
import { signedIn } from "../services.js";
import { WOOCOMMERCE, wooPagesIn } from "../woocommerce.js";

export const handle = { ...WOOCOMMERCE, keepsData: false };
const pressed = createContext(false);

export async function loader(asked: LoaderFunctionArgs) {
  if (asked.context.get(pressed)) return null;
  return answer(
    await wooPagesIn(asked.context).recovery(
      asked.context.get(signedIn),
      asked.params.order_id ?? "",
    ),
    asked,
  );
}

export async function action(asked: ActionFunctionArgs) {
  asked.context.set(pressed, true);
  return acted(
    async () =>
      wooPagesIn(asked.context).recover(
        asked.context.get(signedIn),
        asked.params.order_id ?? "",
        await formOf(asked.request),
      ),
    asked,
  );
}

export const shouldRevalidate: ShouldRevalidateFunction = ({
  actionResult,
  defaultShouldRevalidate,
}) => actionResult === undefined && defaultShouldRevalidate;

export default function WooRecovery() {
  const loaded = useLoaderData<typeof loader>();
  const view = useActionData<typeof action>() ?? loaded;
  const { base } = useChrome();
  if (view === null) throw new Error("the recovery screen has no view");
  return (
    <Frame tab="orders" title="Recover WooCommerce delivery">
      <WooRecoveryScreen view={view} base={base} />
    </Frame>
  );
}
