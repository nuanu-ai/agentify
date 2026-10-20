import { Button, Field } from "@agentify/ui";
import type { WooRecoveryView } from "../../src/woo-recovery-pages.js";
import { ORDER_WORDS } from "../../src/words.js";
import { Ident } from "../components/copy.js";
import { Fact, Facts } from "../components/list.js";
import { PostForm } from "../components/post-form.js";
import { Word } from "../components/word.js";
import { TestMark } from "./orders.js";
import styles from "./woocommerce-recovery.module.css";

/** What the merchant can do here, in a line; the rules are in the documentation. */
const INTRO: Readonly<Record<WooRecoveryView["mode"], string | null>> = {
  link: "Your shop may hold this order without Agentify knowing it. Find the order whose Transaction ID is this order ID and enter its ID.",
  retry:
    "The shop order and its download are saved. Retry sends the same download; no new shop order is made.",
  delivered: null,
  unavailable: null,
};

/** A shop is read by its name, which is its host, rather than by an address with a scheme. */
const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
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
          <Facts>
            <Fact label="Order ID">
              <Ident value={view.orderId} what="order ID" whole />
            </Fact>
            <Fact label="Price">
              {view.amount}
              <TestMark test={view.test} />
            </Fact>
            <Fact label="Shop">{hostOf(view.shopOrigin)}</Fact>
            {view.wooOrderId === "" || link ? null : (
              <Fact label="Shop order ID">{view.wooOrderId}</Fact>
            )}
            {view.mode === "delivered" ? (
              <Fact label="State">
                <Word word={ORDER_WORDS.delivered} />
              </Fact>
            ) : null}
          </Facts>
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
            {view.message === null ? null : (
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
