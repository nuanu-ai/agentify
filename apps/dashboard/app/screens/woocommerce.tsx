import { lazy, Suspense, useContext } from "react";
import { Link, Navigate } from "react-router";
import type { OnboardingPress, OnboardingView } from "../../src/onboarding.js";
import type { WooShopView } from "../../src/woo-views.js";
import { useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";

const OnboardingAccount = lazy(() =>
  import("./onboarding-account.js").then(({ OnboardingAccount }) => ({
    default: OnboardingAccount,
  })),
);

import { ProductsShop, ShopAccount } from "./shop-context.js";
import styles from "./woocommerce.module.css";

const NotConnected = lazy(() =>
  import("./woo-connecting.js").then(({ NotConnected }) => ({ default: NotConnected })),
);
const Connected = lazy(() =>
  import("./woo-connected.js").then(({ Connected }) => ({ default: Connected })),
);

export function WooShopScreen({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  const onboarding = useContext(ProductsShop);
  const account = useContext(ShopAccount);
  return (
    <div className={styles.page}>
      {onboarding && account.view?.step.otherWays && view.connection === null ? (
        <p className={styles.otherWays}>
          <Link to="/products?ways=choose">Other ways to add products</Link>
        </p>
      ) : null}
      {view.savedProfile ? <p role="status">{view.savedProfile}</p> : null}
      <Suspense fallback={<p role="status">Loading your shop…</p>}>
        {view.connection === null ? (
          <>
            {account.view === undefined ||
            (account.view.step.account === "none" && !account.press?.problem) ? null : (
              <OnboardingAccount view={account.view} press={account.press} />
            )}
            <NotConnected view={view} base={base} />
          </>
        ) : (
          <Connected connection={view.connection} view={view} base={base} />
        )}
      </Suspense>
    </div>
  );
}

/**
 * The shop screen and stored work in the dashboard's frame. A press
 * that was refused is answered with the shop screen, which says why in the
 * panel of the control that was pressed.
 */
export function WooPage({
  view,
  onboarding = false,
  elsewhere,
  account,
  press,
}: Readonly<{
  account?: OnboardingView;
  press?: OnboardingPress;
  view: WooShopView | undefined;
  onboarding?: boolean;
  elsewhere?: string | null;
}>) {
  const { base } = useChrome();
  if (view === undefined) {
    // Back or Forward inside the application to a press's address, where
    // React Router keeps no answer: the shop screen is where the forms are. A
    // read of the address from outside is sent there before any page is drawn.
    return <Navigate to="/woocommerce" replace />;
  }
  return (
    <ProductsShop.Provider value={onboarding}>
      <Frame
        tab={onboarding ? "products" : "integrations"}
        title={onboarding ? "Products" : "WooCommerce"}
        parent={
          onboarding ? undefined : (
            <Link className={styles.parent} to="/integrations">
              ← Integrations
            </Link>
          )
        }
      >
        <ShopAccount.Provider value={{ view: account, press }}>
          <WooShopScreen view={view} base={base} />
        </ShopAccount.Provider>
        {elsewhere ? <p className="note">{elsewhere}</p> : null}
      </Frame>
    </ProductsShop.Provider>
  );
}
