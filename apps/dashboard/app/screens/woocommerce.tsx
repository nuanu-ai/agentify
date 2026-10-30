import { lazy, Suspense, useContext } from "react";
import { Link, Navigate } from "react-router";
import type { WooImportView, WooShopView } from "../../src/woo-views.js";
import { useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { ProductsShop } from "./shop-context.js";
import styles from "./woocommerce.module.css";

const NotConnected = lazy(() =>
  import("./woo-connecting.js").then(({ NotConnected }) => ({ default: NotConnected })),
);
const Connected = lazy(() =>
  import("./woo-connected.js").then(({ Connected }) => ({ default: Connected })),
);
const WooImportPage = lazy(() =>
  import("./woo-import.js").then(({ WooImportPage }) => ({ default: WooImportPage })),
);

export function WooShopScreen({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  const onboarding = useContext(ProductsShop);
  return (
    <div className={styles.page}>
      {onboarding && view.connection === null ? (
        <p className={styles.otherWays}>
          <Link to="/products?ways=choose">← Other ways to add products</Link>
        </p>
      ) : null}
      <Suspense fallback={<p role="status">Loading your shop…</p>}>
        {view.connection === null ? (
          <NotConnected view={view} base={base} />
        ) : (
          <Connected connection={view.connection} view={view} base={base} />
        )}
      </Suspense>
    </div>
  );
}

/**
 * The shop screen, or what an import did, in the dashboard's frame. A press
 * that was refused is answered with the shop screen, which says why in the
 * panel of the control that was pressed.
 */
export function WooPage({
  view,
  onboarding = false,
  elsewhere,
}: Readonly<{
  view: WooShopView | WooImportView | undefined;
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
      {view.screen === "shop" ? (
        <Frame
          tab={onboarding ? "products" : "integrations"}
          title={onboarding ? "Products" : "WooCommerce"}
        >
          <WooShopScreen view={view} base={base} />
          {elsewhere ? <p className="note">{elsewhere}</p> : null}
        </Frame>
      ) : (
        <Suspense
          fallback={
            <Frame
              tab={onboarding ? "products" : "integrations"}
              title={onboarding ? "Products" : "WooCommerce import"}
            >
              <p role="status">Loading…</p>
            </Frame>
          }
        >
          <WooImportPage view={view} base={base} onboarding={onboarding} />
        </Suspense>
      )}
    </ProductsShop.Provider>
  );
}
