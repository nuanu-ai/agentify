import { Button } from "@agentify/ui";
import { lazy, Suspense } from "react";
import { codeProducts, offSaleOnKeys } from "../../src/woo-product-words.js";
import type { ConnectionView, WooShopView } from "../../src/woo-views.js";
import { PanelHead } from "../display/panel-head.js";
import { ShopForm } from "./shop-context.js";
import { Problem } from "./woo-panels.js";

import styles from "./woocommerce.module.css";

const RatePanel = lazy(() =>
  import("./woo-rate.js").then(({ RatePanel }) => ({ default: RatePanel })),
);

/** The access and integration settings are only needed away from a selling shop. */
export function ConnectionSettings({
  connection,
  view,
  base,
}: Readonly<{
  connection: ConnectionView;
  view: WooShopView;
  base: string;
}>) {
  if (connection.access !== "read_write")
    return <ReadOnlyPanel connection={connection} view={view} base={base} />;
  return (
    <div className="settings-grid">
      <SwitchPanel connection={connection} view={view} base={base} />
      {connection.rate === null ? null : (
        <Suspense fallback={null}>
          <RatePanel rate={connection.rate} />
        </Suspense>
      )}
    </div>
  );
}

export function ReconnectShop({
  connection,
  className,
}: Readonly<{ connection: ConnectionView; className?: string }>) {
  return (
    <ShopForm action="/woocommerce/connect" {...(className === undefined ? {} : { className })}>
      {(pending) => (
        <>
          <input type="hidden" name="checked_shop" value={connection.shopUrl} autoComplete="off" />
          <input type="hidden" name="shop_url" value={connection.shopUrl} autoComplete="off" />
          <Button pending={pending}>Connect again</Button>
        </>
      )}
    </ShopForm>
  );
}

function SwitchPanel({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  return (
    <section className="settings-panel settings-wide">
      <PanelHead
        title="Sell through this shop"
        said={<Problem said={connection.switching} base={base} />}
      >
        <p>
          This shop's products are off sale while you sell through your own code.
          {view.codeProducts === 0
            ? null
            : ` Switching takes ${codeProducts(view.codeProducts)} off sale until you disconnect the shop.`}
        </p>
      </PanelHead>
      <ShopForm action="/woocommerce/switch" className="issue">
        {(pending) => <Button pending={pending}>Sell through this shop</Button>}
      </ShopForm>
    </section>
  );
}

export function SitePanel({
  site,
  base,
}: Readonly<{ site: NonNullable<ConnectionView["site"]>; base: string }>) {
  return site.kind === "invalid" ? (
    <div className={styles.site}>
      <p>
        {site.origin} can't be your shop's site
        {new URL(site.origin).port !== ""
          ? " because it has a port."
          : ". Set an https domain without a port in Settings."}
      </p>
      <a className="button button-primary" href={`${base}/settings`}>
        Set your site in Settings
      </a>
    </div>
  ) : (
    <div className={styles.site}>
      {site.problem === null ? null : (
        <p className="problem" role="alert">
          {site.problem}
        </p>
      )}
      <ShopForm action="/woocommerce/site" className="issue">
        {(pending) => <Button pending={pending}>Use {site.origin} as your shop's site</Button>}
      </ShopForm>
    </div>
  );
}

function ReadOnlyPanel({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  return (
    <section className="settings-panel">
      <PanelHead
        title="Approve read and write access"
        said={<Problem said={view.problem} base={base} />}
      >
        <p>
          {connection.access === "read"
            ? "Your shop gave Agentify read-only access, so Agentify can't create orders there and agents can't buy. Connect again and approve Read/Write access."
            : "Your shop didn't grant Read/Write access, so Agentify can't create orders there and agents can't buy. Connect again and approve Read/Write access."}
          {connection.onCode && view.codeProducts !== 0
            ? ` When the shop connects, ${offSaleOnKeys(view.codeProducts)}.`
            : null}
        </p>
      </PanelHead>
      <ReconnectShop connection={connection} className="issue" />
    </section>
  );
}
