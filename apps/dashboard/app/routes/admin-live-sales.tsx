import {
  type ActionFunctionArgs,
  createContext,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
  useActionData,
  useLoaderData,
} from "react-router";
import { acted, answer, formOf } from "../answer.js";
import { Frame } from "../components/frame.js";
import { LiveSalesScreen } from "../screens/live-sales.js";
import { services } from "../services.js";

export const handle = { script: false, keepsData: false };
const pressed = createContext(false);

const pagesIn = (asked: LoaderFunctionArgs | ActionFunctionArgs) => {
  const pages = asked.context.get(services).liveSales;
  if (pages === null) {
    answer({ kind: "problem", problem: { status: 404, said: "There is no such page." } }, asked);
    throw new Error("the missing page did not stop the request");
  }
  return pages;
};

export async function loader(asked: LoaderFunctionArgs) {
  if (asked.context.get(pressed)) return null;
  return answer(await pagesIn(asked).page(asked.request.headers.get("cookie") ?? undefined), asked);
}

export async function action(asked: ActionFunctionArgs) {
  asked.context.set(pressed, true);
  return acted(
    async () =>
      pagesIn(asked).press(
        asked.request.headers.get("cookie") ?? undefined,
        await formOf(asked.request),
      ),
    asked,
  );
}

export const shouldRevalidate: ShouldRevalidateFunction = ({
  actionResult,
  defaultShouldRevalidate,
}) => actionResult === undefined && defaultShouldRevalidate;

export default function LiveSales() {
  const loaded = useLoaderData<typeof loader>();
  const view = useActionData<typeof action>() ?? loaded;
  if (view === null) throw new Error("the approval screen has no view");
  return (
    <Frame
      title="Live sales approval"
      navigation={{
        label: "Admin sections",
        sections: [
          { key: "live-sales", label: "Live sales", to: "/admin/live-sales", current: true },
        ],
      }}
    >
      <LiveSalesScreen view={view} />
    </Frame>
  );
}
