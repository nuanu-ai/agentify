import { lazy, Suspense, useEffect } from "react";
import {
  type ActionFunctionArgs,
  createContext,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
  useActionData,
  useLoaderData,
  useRevalidator,
  useRouteLoaderData,
  useSearchParams,
} from "react-router";
import type { KeysView, NewKeyView } from "../../src/keys.js";
import type { Platform } from "../../src/next-step.js";
import type { OnboardingPress } from "../../src/onboarding.js";
import type { FrameView } from "../../src/views.js";
import type { WooShopView } from "../../src/woo-views.js";
import { acted, formOf, readOnly, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { readFailedIn } from "../components/not-loaded.js";
import "../screens/onboarding.module.css";
import "../screens/cards.module.css";
import "../screens/keys.module.css";
import "../screens/woocommerce.module.css";

const ProductsCatalog = lazy(() =>
  import("../screens/products-catalog.js").then(({ ProductsCatalog }) => ({
    default: ProductsCatalog,
  })),
);

const ProductsOnboarding = lazy(() =>
  import("../screens/products-onboarding.js").then(({ ProductsOnboarding }) => ({
    default: ProductsOnboarding,
  })),
);

const WooPage = lazy(() =>
  import("../screens/woocommerce.js").then(({ WooPage }) => ({ default: WooPage })),
);

import { services, signedIn } from "../services.js";

// The catalog is the default initial branch; newcomer branches are measured in Chromium.
export const handle = { initialScripts: ["app/screens/products-catalog.tsx"] };

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
    KeysView | NewKeyView | WooShopView | OnboardingPress | { problem: string; platform?: Platform }
  >(async () => {
    const form = await formOf(request);
    const person = context.get(signedIn);
    const pages = context.get(services);
    if (
      ["request-live-sales", "save-onboarding-profile", "save-onboarding-wallet"].includes(
        String(form.get("intent")),
      )
    )
      return await pages.onboarding.account(person, form);
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
  const issued =
    pressed && "screen" in pressed && pressed.screen === "issued" ? pressed : undefined;
  const onboardingPress =
    pressed && "screen" in pressed && pressed.screen === "onboarding" ? pressed : undefined;
  const frame = useRouteLoaderData<FrameView>("routes/merchant-only");
  const onboarding = frame?.onboarding;
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!onboarding?.publicationPending) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle")
        void revalidator.revalidate();
    }, 5_000);
    return () => clearInterval(timer);
  }, [onboarding?.publicationPending, revalidator]);
  const empty = (view === null || view.empty) && onboarding !== undefined;
  const shop = pressed && "screen" in pressed && pressed.screen === "shop" ? pressed : view?.shop;
  const choosingShop =
    onboarding?.step.otherWays &&
    query.get("ways") === "choose" &&
    shop?.screen === "shop" &&
    shop.connection === null;
  if (
    issued === undefined &&
    !choosingShop &&
    shop !== undefined &&
    (view === null || view.empty) &&
    (onboarding?.step.page === "shop" ||
      (pressed && "screen" in pressed && pressed.screen === "shop"))
  )
    return (
      <Suspense
        fallback={
          <Frame tab="products" title="Products">
            <p role="status">Loading your shop…</p>
          </Frame>
        }
      >
        <WooPage
          view={shop}
          onboarding
          elsewhere={view?.elsewhere}
          account={onboarding}
          press={onboardingPress}
        />
      </Suspense>
    );
  const keyView = pressed && "screen" in pressed && pressed.screen === "list" ? pressed : undefined;
  const problem =
    pressed && "problem" in pressed && typeof pressed.problem === "string"
      ? pressed.problem
      : undefined;
  if (!empty && view !== null && issued === undefined)
    return (
      <Suspense
        fallback={
          <Frame tab="products" title="Products">
            <p role="status">Loading…</p>
          </Frame>
        }
      >
        <ProductsCatalog
          view={view}
          base={chrome.base}
          shop={shop}
          account={onboarding}
          press={onboardingPress}
        />
      </Suspense>
    );
  return (
    <Frame tab="products" title="Products">
      {empty || issued !== undefined ? (
        <Suspense fallback={<p role="status">Loading…</p>}>
          <ProductsOnboarding
            view={onboarding}
            choose={choosingShop}
            press={onboardingPress}
            selected={pressed && "platform" in pressed ? pressed.platform : undefined}
            problem={problem}
            keyView={keyView}
            issued={issued}
          />
        </Suspense>
      ) : null}
      {view?.elsewhere ? <p className="note">{view.elsewhere}</p> : null}
    </Frame>
  );
}

export const ErrorBoundary = readFailedIn({ tab: "products", title: "Products", what: "products" });
