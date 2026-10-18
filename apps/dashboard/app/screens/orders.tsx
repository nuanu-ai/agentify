import { Fragment } from "react";
import type { Shares } from "../../src/shares.js";
import type { OrdersView } from "../../src/views.js";
import { Ident } from "../components/copy.js";
import { Cell, DayHeading, Group, List, ListEmpty, Row, RowMore } from "../components/list.js";
import { CutNote, ListTools, NothingHere } from "../components/listing.js";
import { Moment } from "../components/moment.js";
import { Rest } from "../components/rest.js";
import { Word } from "../components/word.js";
import styles from "./orders.module.css";

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

/**
 * An order that needs saying in full, in a row of its own: its state, its
 * product and its sum, then what happened and what is the merchant's to do,
 * then its ID and when its price was set.
 */
const Told = ({ order }: Readonly<{ order: OrdersView["needsYou"][number] }>) => (
  <li className={styles.told}>
    <div className={styles.state}>
      <Word word={order.state} />
    </div>
    <div className={styles.product}>{order.product}</div>
    <div className={styles.amount}>
      {order.amount}
      <TestMark test={order.test} />
    </div>
    <p className={styles.why}>
      {order.why}
      {order.rest === null ? null : <Rest rest={order.rest} />}
    </p>
    <div className={styles.meta}>
      <Ident value={order.id} what="order ID" />
      <span>
        Price set <Moment at={order.priceSet} />
      </span>
    </div>
  </li>
);

export function OrdersScreen({ view }: Readonly<{ view: OrdersView }>) {
  const { listing } = view;
  const here = listing.segments.find((one) => one.here);
  const note = (
    <p className="note">
      Purchases that closed before they had a price are not listed; nothing was charged for them.
    </p>
  );
  if (view.none) {
    return (
      <>
        <ListEmpty>No orders yet.</ListEmpty>
        {note}
      </>
    );
  }
  return (
    <>
      <ListTools
        listing={listing}
        path="/orders"
        label="Search orders"
        placeholder="Search by order ID or product"
      />
      {view.testNote === null ? null : <p className="problem">{view.testNote}</p>}
      {view.needsYou.length === 0 ? null : (
        <Group
          title="Needs you"
          count={view.needsYou.length}
          warn
          aside={
            <a className={styles.end} href="/docs/money#if-the-buyer-did-not-get-the-goods">
              How refunds work
            </a>
          }
        >
          <List label="Orders that need you" columns="1fr">
            {view.needsYou.map((order) => (
              <Told key={order.id} order={order} />
            ))}
          </List>
        </Group>
      )}
      {view.waitsOnTheBuyer.length === 0 ? null : (
        <Group
          title="Waiting on the buyer"
          count={view.waitsOnTheBuyer.length}
          aside="Nothing for you to do"
        >
          <List label="Orders waiting on the buyer" columns="1fr">
            {view.waitsOnTheBuyer.map((order) => (
              <Told key={order.id} order={order} />
            ))}
          </List>
        </Group>
      )}
      <Group
        title={here?.key === "open" ? "Open orders" : "All orders"}
        count={here?.count ?? listing.rows.length}
      >
        {listing.rows.length === 0 ? (
          <NothingHere listing={listing} />
        ) : (
          <List
            label={here?.key === "open" ? "Open orders" : "All orders"}
            columns="6rem minmax(12rem, 1fr) 9.5rem minmax(10rem, 13rem) 9rem"
            // "Price set", not "Bought": the moment is when the price was
            // fixed, and where the price is checked at purchase the buyer may
            // pay well after it.
            head={["Price set", "Product", { text: "Amount", end: true }, "State", "Order"]}
          >
            {listing.rows.map((row, at) => (
              <Fragment key={row.id}>
                {row.day === listing.rows[at - 1]?.day ? null : <DayHeading>{row.day}</DayHeading>}
                <Row>
                  <Cell at="fact">
                    {"time" in row.priceSet ? row.priceSet.time : row.priceSet.text}
                  </Cell>
                  <Cell at="title">{row.product}</Cell>
                  <Cell at="amount">
                    <span className={styles.sum}>
                      {row.amount}
                      <TestMark test={row.test} />
                    </span>
                    {row.shares === null ? null : (
                      <Cell at="aside">
                        <div className={`under ${styles.sum}`}>{row.shares.merchant} to you</div>
                      </Cell>
                    )}
                  </Cell>
                  <Cell at="state">
                    <span className={styles.wraps}>
                      <Word word={row.state} />
                    </span>
                  </Cell>
                  <Cell at="aside">
                    <Ident value={row.id} what="order ID" />
                  </Cell>
                  <RowMore
                    summary={row.shares === null ? "Order ID" : "Order ID and shares"}
                    of={row.product}
                  >
                    <Ident value={row.id} what="order ID" whole />
                    <SharesOf shares={row.shares} />
                    <div className="under">
                      Price set <Moment at={row.priceSet} />
                    </div>
                  </RowMore>
                </Row>
              </Fragment>
            ))}
          </List>
        )}
        <CutNote cut={listing.cut} />
      </Group>
      {note}
    </>
  );
}
