import { Button, Field } from "@agentify/ui";
import type { ReactNode } from "react";
import type { WooRecoveryView } from "../../src/woo-recovery-pages.js";
import { shopNameOf } from "../../src/woo-views.js";
import { ORDER_WORDS } from "../../src/words.js";
import { Ident } from "../components/copy.js";
import { Fact, Facts } from "../components/list.js";
import { PostForm } from "../components/post-form.js";
import { Word } from "../components/word.js";
import styles from "./woocommerce-recovery.module.css";

/** Where the parcel's rules are written; this page recovers downloads only. */
const PARCELS = "/docs/woocommerce#parcels";

/** What the merchant does here, in a line, under what the last press came to. */
const introOf = (view: WooRecoveryView): string | null =>
  view.mode === "create"
    ? "Your shop never got this order, so the buyer has nothing yet. Create it now: Agentify makes the order in your shop once, at the price the buyer paid, and sends the download."
    : view.mode === "link"
      ? "Your shop may have created this order without telling Agentify. Find the WooCommerce order whose Transaction ID is the order ID below, and enter its number."
      : view.mode === "retry"
        ? `Shop order ${view.wooOrderId} is linked. Retry sends its download again without making a new order.`
        : null;

/** A link styled as the panel's one action, under the facts. */
function Next({
  to,
  primary = false,
  children,
}: Readonly<{ to: string; primary?: boolean; children: ReactNode }>) {
  return (
    <div className={styles.next}>
      <a className={primary ? "button button-primary" : "button button-secondary"} href={to}>
        {children}
      </a>
    </div>
  );
}

export function WooRecoveryScreen({
  view,
  base,
}: Readonly<{ view: WooRecoveryView; base: string }>) {
  const link = view.mode === "link";
  const acts = (link || view.mode === "retry" || view.mode === "create") && !view.unknown;
  const intro = introOf(view);
  const here = `${base}/integrations/woocommerce/recover/${encodeURIComponent(view.orderId)}`;
  const onOrders = `${base}/orders?${new URLSearchParams({ q: view.orderId })}`;
  return (
    <>
      <div className="settings-grid">
        <section
          className={`settings-panel settings-wide ${styles.panel}`}
          aria-labelledby="recovery-sale"
        >
          <div className="lede">
            <div>
              <h2 id="recovery-sale">{view.product}</h2>
              {view.mode === "delivered" ? (
                <p className={styles.result}>
                  <Word word={ORDER_WORDS.delivered} /> Nothing more to do here.
                </p>
              ) : null}
              {view.message === null ? null : (
                <p className="problem" role="alert">
                  {view.message}
                </p>
              )}
              {view.unavailable === null ? null : <p>{view.unavailable.why}</p>}
              {intro === null || view.unknown ? null : <p>{intro}</p>}
            </div>
          </div>
          <Facts>
            <Fact label="Order ID">
              <Ident value={view.orderId} what="order ID" whole />
            </Fact>
            <Fact label="Price">{view.amount}</Fact>
            <Fact label="Shop">{shopNameOf(view.shopOrigin)}</Fact>
            {view.wooOrderId === "" || link ? null : (
              <Fact label="Shop order ID">{view.wooOrderId}</Fact>
            )}
          </Facts>
          {view.unknown ? (
            <Next to={here} primary>
              Reload
            </Next>
          ) : view.unavailable?.instead === "close" ? (
            <Next to={onOrders}>Close fulfillment</Next>
          ) : view.unavailable?.instead === "reconnect" ? (
            <Next to={`${base}/woocommerce`} primary>
              Connect shop again
            </Next>
          ) : view.unavailable?.instead === "parcel" ? (
            <Next to={PARCELS}>Parcel rules</Next>
          ) : null}
          {acts ? (
            <PostForm
              document
              action={`/integrations/woocommerce/recover/${encodeURIComponent(view.orderId)}`}
              className="issue"
            >
              {(pending) => (
                <>
                  {link ? (
                    <Field
                      label="Shop order ID"
                      name="woo_order_id"
                      type="text"
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      defaultValue={view.wooOrderId}
                      autoComplete="off"
                      hint="Open the order in WooCommerce and use the number after id= or post= in the address bar."
                      {...(view.typedRefusal === null ? {} : { error: view.typedRefusal })}
                      required
                    />
                  ) : null}
                  <Button pending={pending}>
                    {link
                      ? "Link and deliver"
                      : view.mode === "create"
                        ? "Create shop order"
                        : "Retry delivery"}
                  </Button>
                </>
              )}
            </PostForm>
          ) : null}
          {acts && link ? (
            <p className={`quiet ${styles.instead}`}>
              No such order in your shop? <a href={onOrders}>Close fulfillment</a>
            </p>
          ) : null}
          {acts && view.mode === "create" ? (
            <p className={`quiet ${styles.instead}`}>
              Can't sell it after all? <a href={onOrders}>Close fulfillment</a>
            </p>
          ) : null}
        </section>
      </div>
      <p className="quiet">
        <a href={`${base}/orders`}>Back to Orders</a>
      </p>
    </>
  );
}
