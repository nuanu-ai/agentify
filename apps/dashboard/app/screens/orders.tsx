import { Table } from "@agentify/ui";
import { Link } from "react-router";
import type { OrdersView } from "../../src/views.js";
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

export function OrdersScreen({ view }: Readonly<{ view: OrdersView }>) {
  return (
    <>
      <div className="lede">
        <div>
          {view.lede === null ? null : <p>{view.lede}</p>}
          {view.testNote === null ? null : <p className="problem">{view.testNote}</p>}
        </div>
        <div className="filter">
          {view.open ? (
            <span className="here">Open</span>
          ) : (
            <Link to="/orders?open=true" prefetch="intent">
              Open
            </Link>
          )}
          {view.open ? (
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
      {view.callouts.map((callout) => (
        <div className="callout" key={callout.id}>
          <div className="what">
            Order <span className="mono">{callout.id}</span> {callout.state}
          </div>
          <div className="why">
            {callout.why}
            {callout.rest === null ? null : <Rest rest={callout.rest} />}
          </div>
        </div>
      ))}
    </>
  );
}
