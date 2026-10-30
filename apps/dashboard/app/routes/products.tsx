import { lazy, Suspense } from "react";
import {
  type ActionFunctionArgs,
  createContext,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
  useActionData,
  useLoaderData,
  useRouteLoaderData,
  useSearchParams,
} from "react-router";
import type { KeysView, NewKeyView } from "../../src/keys.js";
import type { Platform } from "../../src/next-step.js";
import type { FrameView } from "../../src/views.js";
import type { WooImportView, WooShopView } from "../../src/woo-views.js";
import { acted, formOf, readOnly, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { readFailedIn } from "../components/not-loaded.js";
import { AllSelling, CardsScreen } from "../screens/cards.js";
import { NewKeyScreen } from "../screens/new-key.js";
import "../screens/onboarding.module.css";
import "../screens/woocommerce.module.css";

const OnboardingScreen = lazy(() =>
  import("../screens/onboarding.js").then(({ OnboardingScreen }) => ({
    default: OnboardingScreen,
  })),
);

const WooPage = lazy(() =>
  import("../screens/woocommerce.js").then(({ WooPage }) => ({ default: WooPage })),
);

import { services, signedIn } from "../services.js";

const keyPressed = createContext(false);

export async function loader(asked: LoaderFunctionArgs) {
  const { url, context } = asked;
  if (context.get(keyPressed)) return null;
  return readOnly(
    async () => await context.get(services).screens.cards(context.get(signedIn), url.searchParams),
    asked,
  );
}

/**
 * The switches on the page, each naming itself in the address it posts to and
 * carrying the list it was pressed on.
 */
export async function action(asked: ActionFunctionArgs) {
  const { url, context, request } = asked;
  return acted<
    KeysView | NewKeyView | WooShopView | WooImportView | { problem: string; platform?: Platform }
  >(async () => {
    const form = await formOf(request);
    const person = context.get(signedIn);
    const pages = context.get(services);
    const woo = url.searchParams.get("woo");
    if (woo !== null)
      return await pages.onboarding.shopPress(
        person,
        woo,
        form,
        request.headers.get("cookie") ?? undefined,
      );
    if (form.has("platform") || form.get("intent") === "acknowledge-test")
      return await pages.onboarding.press(person, form);
    if (form.get("intent") === "create-key") {
      context.set(keyPressed, true);
      return await pages.keys.issue(person, form);
    }
    return await pages.selling.press(person, url.searchParams, form);
  }, asked);
}

export const shouldRevalidate: ShouldRevalidateFunction = ({
  actionResult,
  defaultShouldRevalidate,
}) => (actionResult && "screen" in actionResult ? false : defaultShouldRevalidate);

export default function Products() {
  const chrome = useChrome();
  const [query] = useSearchParams();
  const view = useLoaderData<typeof loader>();
  const pressed = useActionData<typeof action>();
  const frame = useRouteLoaderData<FrameView>("routes/merchant-only");
  const onboarding = frame?.onboarding;
  const empty = (view === null || view.empty !== null) && onboarding !== undefined;
  const shop =
    pressed && "screen" in pressed && (pressed.screen === "shop" || pressed.screen === "import")
      ? pressed
      : view?.shop;
  const choosingShop =
    query.get("ways") === "choose" && shop?.screen === "shop" && shop.connection === null;
  if (
    !choosingShop &&
    shop !== undefined &&
    (onboarding?.step.page === "shop" ||
      (pressed &&
        "screen" in pressed &&
        (pressed.screen === "shop" || pressed.screen === "import")))
  )
    return (
      <Suspense
        fallback={
          <Frame tab="products" title="Products">
            <p role="status">Loading your shop…</p>
          </Frame>
        }
      >
        <WooPage view={shop} onboarding elsewhere={view?.elsewhere} />
      </Suspense>
    );
  const keyView = pressed && "screen" in pressed && pressed.screen === "list" ? pressed : undefined;
  const problem =
    pressed && "problem" in pressed && typeof pressed.problem === "string"
      ? pressed.problem
      : undefined;
  return (
    <Frame
      tab="products"
      title="Products"
      action={empty || view === null ? null : <AllSelling view={view} />}
    >
      {empty ? (
        <Suspense fallback={<p role="status">Loading…</p>}>
          <OnboardingScreen
            view={onboarding}
            choose={choosingShop}
            {...(pressed && "platform" in pressed && pressed.platform !== undefined
              ? { selected: pressed.platform }
              : {})}
            {...(problem === undefined ? {} : { problem })}
            {...(keyView === undefined ? {} : { keyView })}
          />
        </Suspense>
      ) : view === null ? null : (
        <CardsScreen view={view} base={chrome.base} />
      )}
      {pressed && "screen" in pressed && pressed.screen === "issued" ? (
        <NewKeyScreen view={pressed} doneTo="/products" />
      ) : null}
    </Frame>
  );
}

export const ErrorBoundary = readFailedIn({ tab: "products", title: "Products", what: "products" });
