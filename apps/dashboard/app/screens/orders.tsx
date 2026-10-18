import { Fragment } from "react";
import { Link } from "react-router";
import type { Shares } from "../../src/shares.js";
import type { OrdersView } from "../../src/views.js";
import { Ident } from "../components/copy.js";
import { useGoingTo } from "../components/going-to.js";
import { Cell, DayHeading, Group, List, ListEmpty, Row, RowMore } from "../components/list.js";
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

/** Each order that needs saying in full, in its own box under its group's heading. */
const Callouts = ({ callouts }: Readonly<{ callouts: OrdersView["needsYou"] }>) =>
  callouts.map((callout) => (
    <div className="callout" key={callout.id}>
      <div className="what">
        <Word word={callout.state} /> <Ident value={callout.id} what="order ID" />
      </div>
      <p className="why">
        {callout.why}
        {callout.rest === null ? null : <Rest rest={callout.rest} />}
      </p>
    </div>
  ));

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
      {view.needsYou.length === 0 ? null : (
        <Group title="Needs you" count={view.needsYou.length} warn>
          <Callouts callouts={view.needsYou} />
        </Group>
      )}
      {view.waitsOnTheBuyer.length === 0 ? null : (
        <Group
          title="Waiting on the buyer"
          count={view.waitsOnTheBuyer.length}
          aside="Nothing for you to do"
        >
          <Callouts callouts={view.waitsOnTheBuyer} />
        </Group>
      )}
      <Group title={view.open ? "Open orders" : "All orders"} count={view.rows.length}>
        {view.rows.length === 0 ? (
          <ListEmpty>{view.empty}</ListEmpty>
        ) : (
          <List
            label={view.open ? "Open orders" : "All orders"}
            columns="6.5rem minmax(12rem, 1fr) 9rem 9rem 10rem"
            // "Price set", not "Bought": the moment is when the price was
            // fixed, and where the price is checked at purchase the buyer may
            // pay well after it.
            head={["Price set", "Product", { text: "Amount", end: true }, "State", "Order"]}
          >
            {view.rows.map((row, at) => (
              <Fragment key={row.id}>
                {row.day === view.rows[at - 1]?.day ? null : <DayHeading>{row.day}</DayHeading>}
                <Row needsYou={row.needsYou}>
                  <Cell at="fact">
                    {"time" in row.priceSet ? row.priceSet.time : row.priceSet.text}
                  </Cell>
                  <Cell at="main">
                    <Cell at="title">{row.product}</Cell>
                    <Cell at="aside">
                      <span className="mono">{row.itemId}</span>
                    </Cell>
                  </Cell>
                  <Cell at="amount">
                    {row.amount}
                    <TestMark test={row.test} />
                    <Cell at="aside">
                      <SharesOf shares={row.shares} />
                    </Cell>
                  </Cell>
                  <Cell at="state">
                    <Word word={row.state} />
                  </Cell>
                  <Cell at="aside">
                    <Ident value={row.id} what="order ID" />
                  </Cell>
                  <RowMore summary="Order ID and shares">
                    <Ident value={row.id} what="order ID" />
                    <div className="mono">{row.itemId}</div>
                    <SharesOf shares={row.shares} />
                  </RowMore>
                </Row>
              </Fragment>
            ))}
          </List>
        )}
      </Group>
      <p className="note">
        Purchases that closed before they had a price do not appear here: for example, you said the
        product was out of stock, or you did not answer a price request. No money was charged for
        them.
      </p>
    </>
  );
}
