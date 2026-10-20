import { Button, Field } from "@agentify/ui";
import { Fragment } from "react";
import { Link } from "react-router";
import type { Shares } from "../../src/shares.js";
import type { OrdersView, ToldOrders } from "../../src/views.js";
import { Ident } from "../components/copy.js";
import { Cell, DayHeading, Group, List, ListEmpty, Row, RowMore } from "../components/list.js";
import { CutNote, ListTools, NothingHere } from "../components/listing.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
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
const Told = ({ order }: Readonly<{ order: ToldOrders["rows"][number] }>) => (
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
      <Link
        to={{
          pathname: "/orders",
          search: `?${new URLSearchParams({ q: order.id, details: order.id })}`,
          hash: `#details-${order.id}`,
        }}
      >
        Order details
      </Link>
      <span>
        Price set <Moment at={order.priceSet} />
      </span>
    </div>
  </li>
);

/** Orders told in full, and under them how many of how many where they were cut. */
const ToldList = ({ told, label }: Readonly<{ told: ToldOrders; label: string }>) => (
  <>
    <List label={label} columns="1fr">
      {told.rows.map((order) => (
        <Told key={order.id} order={order} />
      ))}
    </List>
    {told.rows.length === told.of ? null : (
      <p className="cut">{`Showing the newest ${told.rows.length} of ${told.of}`}</p>
    )}
  </>
);

const CloseFulfillment = ({ id }: Readonly<{ id: string }>) => (
  <PostForm action="/orders" className={styles.close}>
    {(pending) => (
      <>
        <input type="hidden" name="order_id" value={id} />
        <h3>Close fulfillment</h3>
        <p>
          Stop further delivery through Agentify for this order. This cannot be undone and does not
          cancel work in your shop or move money.
        </p>
        <Field
          name="message"
          label="Explanation to the buyer (optional)"
          maxLength={2000}
          autoComplete="off"
          hint="Shown as your statement. Agentify does not verify a refund or agreement."
        />
        <Button variant="secondary" pending={pending}>
          Close fulfillment
        </Button>
      </>
    )}
  </PostForm>
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
      {view.closureNote === null ? null : (
        <p className="problem" role="status">
          {view.closureNote}
        </p>
      )}
      {view.testNote === null ? null : <p className="problem">{view.testNote}</p>}
      {view.needsYou.of === 0 ? null : (
        <Group
          title="Needs you"
          count={view.needsYou.of}
          warn
          aside={
            <a className={styles.end} href="/docs/orders#closing-fulfillment">
              Unfulfilled orders and closure
            </a>
          }
        >
          <ToldList told={view.needsYou} label="Orders that need you" />
        </Group>
      )}
      {view.waitsOnTheBuyer.of === 0 ? null : (
        <Group title="Waiting on the buyer" count={view.waitsOnTheBuyer.of}>
          <ToldList told={view.waitsOnTheBuyer} label="Orders waiting on the buyer" />
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
                    summary="Order details"
                    className={styles.orderDetails}
                    wide
                    id={`details-${row.id}`}
                    open={row.opened || undefined}
                    of={row.product}
                  >
                    <div className={styles.details}>
                      <dl className={styles.facts}>
                        <div>
                          <dt>Order ID</dt>
                          <dd>
                            <Ident value={row.id} what="order ID" whole />
                          </dd>
                        </div>
                        <div>
                          <dt>Original payment</dt>
                          <dd>
                            {row.payment}
                            <TestMark test={row.test} />
                          </dd>
                        </div>
                        <div>
                          <dt>Price set</dt>
                          <dd>
                            <Moment at={row.priceSet} />
                          </dd>
                        </div>
                        {row.shares === null ? null : (
                          <div>
                            <dt>Original shares</dt>
                            <dd className={styles.shares}>
                              <span>{row.shares.merchant} to you</span>
                              <span>{row.shares.commission} to Agentify</span>
                            </dd>
                          </div>
                        )}
                      </dl>
                      {row.paymentUnresolved ? (
                        <p className={styles.help}>
                          A payment already accepted for execution may still complete. Closing
                          fulfillment does not cancel it; Agentify continues checking its original
                          outcome.
                        </p>
                      ) : null}
                      {row.closure === null ? null : (
                        <section className={styles.closure}>
                          <h3>Fulfillment closed by you</h3>
                          <p className={styles.help}>
                            <Moment at={row.closure.at} />
                          </p>
                          {row.closure.message === undefined ? null : (
                            <div className={styles.statement}>
                              <p className={styles.label}>Your explanation to the buyer</p>
                              <p>{row.closure.message}</p>
                            </div>
                          )}
                          <p className={styles.help}>
                            Agentify records your action and statement; it does not confirm a refund
                            or agreement.
                          </p>
                        </section>
                      )}
                      {row.canClose ? <CloseFulfillment id={row.id} /> : null}
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
