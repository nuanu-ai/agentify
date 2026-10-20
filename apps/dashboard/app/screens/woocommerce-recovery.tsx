import { Button, Field } from "@agentify/ui";
import type { WooRecoveryView } from "../../src/woo-recovery-pages.js";
import { Ident } from "../components/copy.js";
import { PostForm } from "../components/post-form.js";
import { TestMark } from "./orders.js";
import orders from "./orders.module.css";
import styles from "./woocommerce-recovery.module.css";

/** What the merchant can do here, in a line; the rules are in the documentation. */
const INTRO: Readonly<Record<WooRecoveryView["mode"], string | null>> = {
  link: "Your shop may hold this order without Agentify knowing it. Find the order whose Transaction ID is this order ID and enter its ID.",
  retry:
    "The shop order and its download are saved. Retry sends the same download; no new shop order is made.",
  delivered: null,
  unavailable: null,
};

export function WooRecoveryScreen({
  view,
  base,
}: Readonly<{ view: WooRecoveryView; base: string }>) {
  const link = view.mode === "link";
  const acts = link || view.mode === "retry";
  const intro = INTRO[view.mode];
  const ordersPage = <a href={`${base}/orders`}>Orders</a>;
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
              {intro === null ? null : <p>{intro}</p>}
            </div>
          </div>
          <dl className={`${orders.facts} ${styles.facts}`}>
            <div>
              <dt>Order ID</dt>
              <dd>
                <Ident value={view.orderId} what="order ID" whole />
              </dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>
                {view.amount}
                <TestMark test={view.test} />
              </dd>
            </div>
            <div>
              <dt>Shop</dt>
              <dd>{view.shopOrigin}</dd>
            </div>
            {view.wooOrderId === "" || link ? null : (
              <div>
                <dt>Shop order ID</dt>
                <dd>{view.wooOrderId}</dd>
              </div>
            )}
          </dl>
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
                      label="WooCommerce order ID"
                      name="woo_order_id"
                      type="text"
                      inputMode="numeric"
                      pattern="[1-9][0-9]*"
                      defaultValue={view.wooOrderId}
                      autoComplete="off"
                      hint="The number in the order's address in your shop, which can differ from its order number."
                      {...(view.typedRefusal === null ? {} : { error: view.typedRefusal })}
                      required
                    />
                  ) : null}
                  <Button pending={pending}>{link ? "Link and deliver" : "Retry delivery"}</Button>
                </>
              )}
            </PostForm>
          ) : null}
          <div className="panel-messages">
            {view.message === null ? null : view.mode === "delivered" ? (
              <p role="status">{view.message}</p>
            ) : (
              <p className="problem" role="alert">
                {view.message}
              </p>
            )}
            {acts ? (
              <p className="quiet">
                {link
                  ? "If your shop holds no such order, nothing can be delivered from here; close fulfillment on "
                  : "To stop delivery instead, close fulfillment on "}
                {ordersPage}.
              </p>
            ) : null}
          </div>
        </section>
      </div>
      <p className="quiet">
        <a href={`${base}/orders`}>Back to Orders</a>
      </p>
    </>
  );
}
