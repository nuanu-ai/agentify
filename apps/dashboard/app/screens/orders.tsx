import { Table } from "@agentify/ui";
import { Link } from "react-router";
import type { Shares } from "../../src/shares.js";
import type { OrdersView } from "../../src/views.js";
import { useGoingTo } from "../components/going-to.js";
import { Moment } from "../components/moment.js";
import { Rest } from "../components/rest.js";
import { Word } from "../components/word.js";

/**
 * An unmarked sum for a test purchase is proof of a payment that never
 * happened, so every test sum carries the mark.
 */
export const TestMark = ({ test }: Readonly<{ test: boolean }>) =>
  test ? (
    <>
      {" "}
      <span className="tag">test</span>
    </>
  ) : null;

/** Under the price, which stays the sum the buyer paid. */
export const SharesOf = ({ shares }: Readonly<{ shares: Shares | null }>) =>
  shares === null ? null : (
    <>
      <div className="under">{shares.merchant} to you</div>
      <div className="under">{shares.commission} to Agentify</div>
    </>
  );

export function OrdersScreen({ view }: Readonly<{ view: OrdersView }>) {
  // The filter chosen is marked as soon as it is clicked.
  const going = useGoingTo();
  const open =
    going?.pathname === "/orders"
      ? new URLSearchParams(going.search).get("open") === "true"
      : view.open;
  return (
    <>
      <div className="lede">
        <div>
          {view.lede === null ? null : <p>{view.lede}</p>}
          {view.testNote === null ? null : <p className="problem">{view.testNote}</p>}
        </div>
        <div className="filter">
          {open ? (
            <span className="here">Open</span>
          ) : (
            <Link to="/orders?open=true" prefetch="intent">
              Open
            </Link>
          )}
          {open ? (
            <Link to="/orders" prefetch="intent">
              All
            </Link>
          ) : (
            <span className="here">All</span>
          )}
        </div>
      </div>
      <Table
        // "Price set", not "Bought": the moment is when the price was fixed,
        // and where the price is checked at purchase the buyer may pay well
        // after it.
        columns={["Order", "Product", "Amount", "State", "Price set"]}
        empty={view.empty}
        rows={view.rows.map((row) => ({
          key: row.id,
          ...(row.needsYou ? { className: "needs-you" } : {}),
          cells: [
            { className: "ident", content: row.id },
            {
              content: (
                <>
                  <div>{row.product}</div>
                  <div className="under mono">{row.itemId}</div>
                </>
              ),
            },
            {
              className: "amount",
              content: (
                <>
                  {row.amount}
                  <TestMark test={row.test} />
                  <SharesOf shares={row.shares} />
                </>
              ),
            },
            { content: <Word word={row.state} /> },
            { className: "quiet moment", content: <Moment at={row.priceSet} /> },
          ],
        }))}
      />
      <p className="note">
        Purchases that closed before they had a price do not appear here: for example, you said the
        product was out of stock, or you did not answer a price request. No money was charged for
        them.
      </p>
      {[...view.needsYou, ...view.waitsOnTheBuyer].map((callout) => (
        <div className="callout" key={callout.id}>
          <div className="what">
            Order <span className="mono">{callout.id}</span> {callout.state}
          </div>
          <p className="why">
            {callout.why}
            {callout.rest === null ? null : <Rest rest={callout.rest} />}
          </p>
        </div>
      ))}
    </>
  );
}
