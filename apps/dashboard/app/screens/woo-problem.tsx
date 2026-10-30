import type { Refusal } from "../../src/woo-views.js";
import { Ident } from "../display/copy.js";
import styles from "./woocommerce.module.css";

/**
 * Why a press was refused, at the top of the panel it was made in, with each
 * order it names to be copied and the way to all of them on Orders.
 */
export function WooProblem({ said, base }: Readonly<{ said: Refusal | null; base: string }>) {
  if (said === null) return null;
  if (said.orders.length === 0) {
    return (
      <>
        <p className="problem">
          {said.says}
          {said.follow === "integrations" ? (
            <>
              {" "}
              Open <a href={`${base}/integrations`}>Integrations</a> to disconnect it.
            </>
          ) : null}
          {said.follow === "pause" ? (
            <>
              {" "}
              <a href={`${base}/orders?show=open`}>See open orders</a>.
            </>
          ) : null}
        </p>
        {said.follow === "pause" ? (
          <p>
            If new purchases keep arriving, <a href={`${base}/products`}>pause all sales</a> first.
          </p>
        ) : said.follow === "products" ? (
          <p>
            Its products appear on <a href={`${base}/products`}>Products</a> as it publishes them.
          </p>
        ) : null}
      </>
    );
  }
  return (
    <div className={styles.refusal}>
      <p className="problem">
        {said.says} <a href={`${base}/orders?show=open`}>See open orders</a>.
      </p>
      <ul className={styles.orders} aria-label="The orders still open">
        {said.orders.map((order) => (
          <li key={order}>
            <Ident value={order} what="order ID" />
          </li>
        ))}
        {said.more === 0 ? null : <li>and {said.more} more</li>}
      </ul>
    </div>
  );
}
