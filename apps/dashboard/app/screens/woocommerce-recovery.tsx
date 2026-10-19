import { Button, Field } from "@agentify/ui";
import type { WooRecoveryView } from "../../src/woo-recovery-pages.js";
import { Ident } from "../components/copy.js";
import { PostForm } from "../components/post-form.js";
import { TestMark } from "./orders.js";
import styles from "./woocommerce-recovery.module.css";

export function WooRecoveryScreen({
  view,
  base,
}: Readonly<{ view: WooRecoveryView; base: string }>) {
  const link = view.mode === "link";
  return (
    <>
      <p>
        <a href={`${base}/orders`}>Back to Orders</a>
      </p>
      <div className="settings-grid">
        <section
          className={`settings-panel settings-wide ${styles.panel}`}
          aria-labelledby="recovery-sale"
        >
          <h2 id="recovery-sale">Order details</h2>
          <dl className={styles.facts}>
            <div>
              <dt>Agentify order ID</dt>
              <dd>
                <Ident value={view.orderId} what="order ID" whole />
              </dd>
            </div>
            <div>
              <dt>Product code</dt>
              <dd>{view.product}</dd>
            </div>
            <div>
              <dt>Whole price</dt>
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
                <dt>Linked WooCommerce order ID</dt>
                <dd>{view.wooOrderId}</dd>
              </div>
            )}
          </dl>
          {view.message === null ? null : (
            <p
              className={view.mode === "delivered" ? "saved" : "problem"}
              role={view.mode === "delivered" ? "status" : "alert"}
            >
              {view.message}
            </p>
          )}
          {view.mode !== "link" && view.mode !== "retry" ? null : (
            <>
              <p>
                {link
                  ? "The shop may already hold this order, but Agentify has no confirmed download to deliver. Find the existing shop order whose Transaction ID is the Agentify order ID above."
                  : "The existing shop order and download are saved. Retry sends that same download to Agentify; it does not create another shop order."}
              </p>
              <p className="quiet">
                This page cannot create a shop order or record a refund. If you already refunded the
                buyer, do not deliver the download.
              </p>
              <PostForm
                document
                action={`/integrations/woocommerce/recover/${encodeURIComponent(view.orderId)}`}
                className={styles.form}
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
                        hint="The internal numeric ID in your shop's order URL can differ from its displayed order number."
                        required
                      />
                    ) : null}
                    <Button pending={pending}>
                      {link ? "Link order and deliver download" : "Retry delivery"}
                    </Button>
                  </>
                )}
              </PostForm>
              {link ? (
                <p className="quiet">
                  Agentify checks that this exact order and product match the saved sale before
                  delivering.
                </p>
              ) : null}
            </>
          )}
          {view.mode === "delivered" ? null : (
            <p>
              <a href={`${base}/woocommerce`}>Your WooCommerce connection</a>
            </p>
          )}
        </section>
      </div>
    </>
  );
}
