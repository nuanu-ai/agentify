import { Button, Field } from "@agentify/ui";
import { type ReactNode, useEffect, useState } from "react";
import { comeBack, offSaleOnKeys } from "../../src/woo-product-words.js";
import type { WooShopView } from "../../src/woo-views.js";
import { NO_SHOP } from "../../src/woo-words.js";
import { PanelHead } from "../display/panel-head.js";
import { ShopAgain, ShopForm } from "./shop-context.js";
import { GUIDE, Problem } from "./woo-panels.js";
import styles from "./woocommerce.module.css";

/** A state that needs the merchant, said once at the top of the page in the notice's colours. */
function Notice({
  what,
  why,
  children,
}: Readonly<{ what: string; why: string; children?: ReactNode }>) {
  return (
    <div className={`callout ${styles.notice}`}>
      <div className="what">{what}</div>
      <p className="why">{why}</p>
      {children}
    </div>
  );
}

function Estimate({ view }: Readonly<{ view: WooShopView }>) {
  const read = view.preview;
  if (read === null || read.kind === "refused") return null;
  if (read.kind === "unread")
    return (
      <p>
        We couldn't read the public product list of {new URL(view.typed).host}, so we can't tell yet
        which products would sell. After you connect, we read them directly.
      </p>
    );
  const { estimate: count, sample } = read;
  const n = (value: number) => value.toLocaleString("en-US");
  const products = count.read === 1 ? "product" : "products";
  const look = count.ready === 1 ? "looks" : "look";
  return (
    <>
      <p>
        {count.total !== null && count.total > count.read
          ? `Your shop lists ${n(count.total)} products. We looked at the first ${n(count.read)}, and ${count.ready === 0 ? "none look" : `${n(count.ready)} ${look}`} ready to sell.`
          : count.ready === 0
            ? `We looked at ${n(count.read)} ${products}, and none look ready to sell.`
            : count.total === count.read
              ? `${n(count.ready)} of ${n(count.total)} ${products} ${look} ready to sell.`
              : `We looked at ${n(count.read)} ${products}, and ${n(count.ready)} ${look} ready to sell.`}
      </p>
      {count.options + count.stock === 0 ? null : (
        <p>
          {count.options === 0
            ? ""
            : `${n(count.options)} ${count.options === 1 ? "has" : "have"} options such as size or colour`}
          {count.options > 0 && count.stock > 0 ? ", and " : ""}
          {count.stock === 0
            ? ""
            : `${n(count.stock)} ${count.stock === 1 ? "counts its" : "count their"} stock`}
          : <a href={`${GUIDE}#what-can-be-imported`}>Agentify can't sell those yet</a>.
        </p>
      )}
      {count.unavailable === 0 ? null : (
        <p>
          {n(count.unavailable)} {count.unavailable === 1 ? "is" : "are"} out of stock or not for
          sale.
        </p>
      )}
      {sample === null || sample.currency === "USD" ? null : (
        <p>
          Your shop prices in {sample.currency}. After connecting, you'll set how many{" "}
          {sample.currency} one US dollar buys.
        </p>
      )}
      <p>
        We see whether products ship or download, and your tax and shipping settings, only after you
        connect.
      </p>
    </>
  );
}

function ConnectPanel({
  view,
  base,
  wide,
}: Readonly<{ view: WooShopView; base: string; wide: boolean }>) {
  const [typed, setTyped] = useState(view.typed);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    setTyped(view.typed);
    setEdited(false);
  }, [view]);
  const checked =
    !edited && (view.preview !== null || (view.noKeysYet !== null && view.problem === null));
  const waiting =
    !edited && view.preview === null && view.problem === null && view.noKeysYet?.waiting === true;
  return (
    <section className={`${styles.connect} ${wide ? "settings-wide" : ""}`}>
      <h2>Connect your WooCommerce shop</h2>
      <ShopForm
        action="/woocommerce/connect"
        className={styles.checkForm}
        answeredWithinMs={15_000}
      >
        {(pending) => (
          <>
            <Field
              label="Shop address"
              name="shop_url"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="shop.example.com"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setEdited(true);
              }}
              {...(edited || view.addressProblem === null ? {} : { error: view.addressProblem })}
              required
            />
            <input
              type="hidden"
              name="checked_shop"
              value={checked ? view.typed : ""}
              autoComplete="off"
            />
            <div className={styles.estimate} aria-live="polite">
              {edited ? null : (
                <>
                  <Problem said={view.problem} base={base} />
                  {view.preview !== null ? (
                    <Estimate view={view} />
                  ) : view.noKeysYet === null || view.problem !== null ? null : (
                    <p>{view.noKeysYet.why}</p>
                  )}
                  {waiting ? (
                    <ShopAgain base={base} className={styles.checkAgain}>
                      Check again
                    </ShopAgain>
                  ) : null}
                </>
              )}
            </div>
            <div className={styles.beforeConnect}>
              {!edited && view.preview !== null ? (
                <p>
                  Next, WooCommerce asks you to approve access. Agentify never sees your shop
                  password.
                </p>
              ) : null}
              {view.testMoney ? (
                <p role="note" aria-label="Test purchases">
                  A test purchase here makes a paid order in the shop you connect, marked as paid in
                  test USDC; if it is your real shop, do not ship for it.
                </p>
              ) : null}
              {view.connectSwitches && view.codeProducts !== 0 ? (
                <p>
                  When your shop connects, {offSaleOnKeys(view.codeProducts)} until you disconnect
                  the shop.
                </p>
              ) : null}
            </div>
            <Button variant={waiting ? "secondary" : "primary"} pending={pending}>
              {!checked
                ? "Check my shop"
                : view.preview === null && view.noKeysYet !== null
                  ? "Connect again"
                  : "Connect shop"}
            </Button>
          </>
        )}
      </ShopForm>
    </section>
  );
}

/** The way back to the merchant's own code, beside Connect and never above it. */
function WayBackPanel({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <section className="settings-panel">
      <PanelHead
        title="Sell through your own code"
        said={<Problem said={view.leaving} base={base} />}
      >
        <p>
          {view.codeProducts === 0
            ? "Go back to publishing products from your own code."
            : comeBack(view.codeProducts)}
        </p>
      </PanelHead>
      <ShopForm action="/woocommerce/disconnect" className="issue">
        {(pending) => (
          <>
            <input type="hidden" name="shop" value={NO_SHOP} autoComplete="off" />
            <Button variant="secondary" pending={pending}>
              Use my own code
            </Button>
          </>
        )}
      </ShopForm>
    </section>
  );
}

export function NotConnected({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <>
      {view.wayBack ? (
        <Notice
          what="No shop is connected, so nothing sells"
          why="Connect your shop, or go back to selling through your own code."
        />
      ) : null}
      <div className="settings-grid">
        <ConnectPanel view={view} base={base} wide={!view.wayBack} />
        {view.wayBack ? <WayBackPanel view={view} base={base} /> : null}
      </div>
    </>
  );
}
