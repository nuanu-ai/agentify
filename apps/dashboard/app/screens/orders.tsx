import { durationInWords, LAPSED_KEPT_MS } from "@agentify/core/published";
import { Button, Field } from "@agentify/ui";
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import type { ClosurePressed, ClosureUnlisted, OrdersView, ToldOrders } from "../../src/views.js";
import { COUNTS_TOWARD_THE_STOP } from "../../src/words.js";
import { Ident, shortened } from "../components/copy.js";
import {
  Cell,
  DayHeading,
  DisclosedRow,
  Fact,
  Facts,
  Group,
  List,
  ListEmpty,
  RowMore,
} from "../components/list.js";
import { CutNote, KeptPlace, ListTools, NothingHere } from "../components/listing.js";
import { Moment } from "../components/moment.js";
import { NotLoaded } from "../components/not-loaded.js";
import { PostForm } from "../components/post-form.js";
import { Rest } from "../components/rest.js";
import { Word } from "../components/word.js";
import styles from "./orders.module.css";

/**
 * A test sum on a page that does not say otherwise which of its sums are
 * tests would be proof of a payment that never happened, so there it carries
 * the mark; where the channel's band says every payment is a test, `test` is
 * false for all of them.
 */
export const TestMark = ({ test }: Readonly<{ test: boolean }>) =>
  test ? (
    <>
      {" "}
      <span className="tag">test</span>
    </>
  ) : null;

type Order = OrdersView["listing"]["rows"][number];

/**
 * An order that needs saying in full, in a row of its own: its state, its
 * product and its sum, then what happened and what is the merchant's to do,
 * then the one way on, which leads to its details or, where `closure` is
 * given, opens the closure in the row itself.
 */
const Told = ({
  order,
  marked,
  closure,
}: Readonly<{ order: ToldOrders["rows"][number]; marked: boolean; closure?: ReactNode }>) => (
  <li className={styles.told}>
    <div className={styles.state}>
      <Word word={order.state} />
    </div>
    <div className={styles.product}>{order.product}</div>
    <div className={styles.amount}>
      {order.amount}
      <TestMark test={marked && order.test} />
    </div>
    <p className={styles.why}>
      {order.why}
      {order.stops ? (
        <>
          {" "}
          <b data-stops={order.id}>{COUNTS_TOWARD_THE_STOP}</b>
        </>
      ) : null}
      {order.rest === null ? null : <Rest rest={order.rest} />}
    </p>
    <div className={styles.way}>
      {closure ?? (
        <Link
          className="button button-secondary button-compact"
          to={{ pathname: "/orders", search: order.opens.search, hash: `#details-${order.id}` }}
        >
          {order.opens.words}
        </Link>
      )}
    </div>
  </li>
);

/** Orders told in full, a row of their own each, each with the closure `closing` draws for it. */
const ToldRows = ({
  told,
  label,
  marked,
  closing,
}: Readonly<{
  told: ToldOrders;
  label: string;
  marked: boolean;
  closing?: (order: ToldOrders["rows"][number]) => ReactNode;
}>) => (
  <List label={label} columns="1fr">
    {told.rows.map((order) => (
      <Told
        key={order.id}
        order={order}
        marked={marked}
        {...(closing === undefined ? {} : { closure: closing(order) })}
      />
    ))}
  </List>
);

/**
 * Orders told in full, and under them how many of how many where they were
 * cut, with the way to the list of them all where there is one.
 */
const ToldList = ({
  told,
  label,
  marked,
  all,
}: Readonly<{ told: ToldOrders; label: string; marked: boolean; all?: string }>) => (
  <>
    <ToldRows told={told} label={label} marked={marked} />
    {told.rows.length === told.of ? null : (
      <p className="cut">
        <span>{`Showing the newest ${told.rows.length} of ${told.of}`}</span>
        {all === undefined ? null : <Link to={all} prefetch="intent">{`Show all ${told.of}`}</Link>}
      </p>
    )}
  </>
);

const pressFor = (again: boolean) => (again ? "Close again" : "Close fulfillment");

/**
 * The same form closes an order the first time and, where its payment
 * completed after that closure, again: the second records its own time and
 * note.
 */
const CloseFulfillment = ({
  id,
  again,
  typed,
  refusal,
  place,
}: Readonly<{
  id: string;
  again: boolean;
  typed: string;
  refusal: string | null;
  place: OrdersView["listing"]["place"];
}>) => {
  const press = pressFor(again);
  return (
    <section className={styles.close} aria-label={press}>
      <p className={styles.help}>
        {again
          ? "The buyer paid after you closed this order. Close it again with a note saying what you did; this moves no money."
          : "Delivery through Agentify stops for this order, and this cannot be undone. It moves no money and changes nothing in your shop."}
      </p>
      <PostForm action="/orders" className="issue">
        {(pending) => (
          <>
            <input type="hidden" name="order_id" value={id} />
            <KeptPlace place={place} />
            <Field
              name="message"
              label="Note to the buyer (optional)"
              rows={3}
              maxLength={2000}
              autoComplete="off"
              defaultValue={typed}
              {...(refusal === null ? {} : { error: refusal })}
              hint="The buyer sees it as you wrote it. Agentify does not check it."
            />
            <Button variant="secondary" pending={pending}>
              {press}
            </Button>
          </>
        )}
      </PostForm>
    </section>
  );
};

/** What an order's line leaves out: its ID, its payment and the merchant's share of it, and what was closed. */
const OrderFacts = ({ row, marked }: Readonly<{ row: Order; marked: boolean }>) => (
  <Facts>
    <Fact label="Order ID">
      <Ident value={row.id} what="order ID" whole />
    </Fact>
    <Fact label="Payment">
      {row.payment}
      <TestMark test={marked && row.test} />
    </Fact>
    {row.facts.map((fact) => (
      <Fact key={fact.label} label={fact.label}>
        <Moment at={fact.at} />
      </Fact>
    ))}
    {row.share === null ? null : <Fact label="Your share">{row.share}</Fact>}
    {row.inTheShop === null ? null : <Fact label="In your shop">{row.inTheShop}</Fact>}
    {row.shopTotal === null ? null : (
      <Fact label="Shop's order total">{row.shopTotal}, within a cent of what the buyer paid</Fact>
    )}
    {row.closure?.message === undefined ? null : (
      <Fact label="Your note to the buyer">
        <span className="words">{row.closure.message}</span>
      </Fact>
    )}
  </Facts>
);

/**
 * Where nobody knows yet whether the buyer paid: what the merchant can do
 * while Agentify looks, and that a closure cancels no payment.
 */
const UNKNOWN_OPEN =
  "Nobody knows yet whether the buyer paid, and Agentify keeps checking. You can wait or close fulfillment now; closing does not cancel the payment, and if it arrives the order comes back to Needs you.";
const UNKNOWN_CLOSED =
  "Nobody knows yet whether the buyer paid, and Agentify keeps checking. Your closure does not cancel the payment: if it arrives, the order comes back to Needs you.";

/** An order's opened part: its facts, then what became of a press on it and the closure. */
const OrderDetails = ({
  row,
  marked,
  pressed,
  place,
}: Readonly<{
  row: Order;
  marked: boolean;
  pressed: ClosurePressed | null;
  place: OrdersView["listing"]["place"];
}>) => {
  const said = pressed?.id === row.id ? pressed : null;
  // A refusal is said under the box it is about; with no form left, here.
  const told = said === null ? null : (said.note ?? (row.closing === null ? said.refusal : null));
  return (
    <div className={styles.details}>
      <OrderFacts row={row} marked={marked} />
      {row.why === null ? null : (
        <p className={styles.help}>
          {row.why}
          {row.rest === null ? null : <Rest rest={row.rest} />}
        </p>
      )}
      {row.paymentUnresolved ? (
        <p className={styles.help}>{row.closing === null ? UNKNOWN_CLOSED : UNKNOWN_OPEN}</p>
      ) : null}
      {told === null ? null : (
        <p className="problem" role="alert">
          {told}
        </p>
      )}
      {said === null || said.typed === "" || row.closing !== null ? null : (
        <>
          <p className={styles.help}>The note you typed:</p>
          <p className={`${styles.help} ${styles.typed}`}>{said.typed}</p>
        </>
      )}
      {row.closing === null ? null : (
        <CloseFulfillment
          id={row.id}
          again={row.closing === "again"}
          typed={said?.typed ?? ""}
          refusal={said?.refusal ?? null}
          place={place}
        />
      )}
    </div>
  );
};

/** Every order the address asks for, a row each, each opening to its details. */
const OrderList = ({ view }: Readonly<{ view: OrdersView }>) => {
  const { listing } = view;
  const marked = view.testNote !== null;
  const here = listing.segments.find((one) => one.here);
  const title =
    here?.key === "open" ? "Open orders" : here?.key === "lapsed" ? "Lapsed unpaid" : "All orders";
  return (
    <Group title={title} count={here?.count ?? listing.rows.length}>
      {listing.rows.length === 0 ? (
        <NothingHere listing={listing} />
      ) : (
        <List
          label={title}
          columns={ORDER_COLUMNS}
          // "Price set", not "Bought": the moment is when the price was
          // fixed, and where the price is checked at purchase the buyer may
          // pay well after it.
          head={["Price set", "Product", "State", { text: "Amount", end: true }, ""]}
        >
          {listing.rows.map((row, at) => (
            <Fragment key={row.id}>
              {row.day === listing.rows[at - 1]?.day ? null : <DayHeading>{row.day}</DayHeading>}
              <DisclosedRow
                of={{ title: row.product, day: row.day, time: row.time, id: row.id }}
                id={`details-${row.id}`}
                open={row.opened || view.pressed?.id === row.id || undefined}
                cells={
                  <>
                    <Cell at="fact">{row.priced === null ? "Not priced" : row.time}</Cell>
                    <Cell at="title">{row.product}</Cell>
                    <Cell at="state">
                      <span className={styles.wraps}>
                        <Word word={row.state} />
                      </span>
                    </Cell>
                    <Cell at="amount">
                      {row.amount}
                      <TestMark test={marked && row.test} />
                    </Cell>
                  </>
                }
              >
                <OrderDetails
                  row={row}
                  marked={marked}
                  pressed={view.pressed}
                  place={listing.place}
                />
              </DisclosedRow>
            </Fragment>
          ))}
        </List>
      )}
      <CutNote cut={listing.cut} />
    </Group>
  );
};

/**
 * The time a price was set, the product, the state, the amount and the
 * chevron. The product takes what the others leave and wraps, so a long name
 * is read whole; the state's column holds "Payment outcome unknown" on one
 * line.
 */
const ORDER_COLUMNS = "7rem minmax(0, 1fr) 12.5rem 8.5rem 1rem";

/**
 * A closure opened from the row it closes, on a list whose rows already say
 * what happened: named by the press it opens, and holding the order's facts
 * and what became of a press made on it.
 */
const CloseInRow = ({
  row,
  marked,
  pressed,
  place,
}: Readonly<{
  row: Order;
  marked: boolean;
  pressed: ClosurePressed | null;
  place: OrdersView["listing"]["place"];
}>) => {
  if (row.closing === null) return null;
  const said = pressed?.id === row.id ? pressed : null;
  return (
    <RowMore
      summary={pressFor(row.closing === "again")}
      wide
      id={`details-${row.id}`}
      open={row.opened || said !== null || undefined}
      of={row.product}
      className={styles.opens}
    >
      <OrderDetails row={row} marked={marked} pressed={pressed} place={place} />
    </RowMore>
  );
};

const closureHelp = (
  <a className={styles.end} href="/docs/orders#closing-fulfillment">
    Unfulfilled orders and closure
  </a>
);

/**
 * Where the segment shown is the orders that need the merchant, they are the
 * list, told in full a page at a time; elsewhere the newest of them are told
 * over the list, with the way to all of them where they are cut.
 */
export function OrdersScreen({ view }: Readonly<{ view: OrdersView }>) {
  const { listing } = view;
  const marked = view.testNote !== null;
  const here = listing.segments.find((one) => one.here);
  const needs = listing.segments.find((one) => one.key === "needs");
  // The page's own links to an order search for its ID and open it; the
  // merchant searched for nothing there, so nothing is said of the search.
  const opening = listing.rows.some(
    (row) => row.opened && row.id.toLowerCase() === listing.search.q.toLowerCase(),
  );
  const note = (
    <p className="note">
      Purchases that ended before they had a price are under Lapsed, not here; nothing was charged
      for them.
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
  const lapsed = here?.key === "lapsed";
  return (
    <>
      <ListTools
        listing={listing}
        path="/orders"
        label="Search orders by ID or product"
        placeholder="Search by order ID or product"
        searchable={!lapsed}
        {...(opening
          ? {}
          : {
              searched: (q: string) =>
                `Only orders whose ID or product matches “${q}” are counted and shown.`,
            })}
      />
      {view.lapsedApart === null ? null : (
        <p className="search-cut">
          {view.lapsedApart.says}{" "}
          <Link to={view.lapsedApart.to} prefetch="intent">
            Lapsed
          </Link>
          .
        </p>
      )}
      {view.testNote === null ? null : <p className="problem">{view.testNote}</p>}
      {view.closedElsewhere === null ? null : (
        <p className="quiet">
          {`Fulfillment closed for ${shortened(view.closedElsewhere.id)} · `}
          <Link to={{ pathname: "/orders", search: view.closedElsewhere.opens }}>
            Show the order
          </Link>
        </p>
      )}
      {lapsed ? (
        <>
          <OrderList view={view} />
          <p className="note">
            Nothing was charged for these, and each is deleted{" "}
            {durationInWords(LAPSED_KEPT_MS, "day")} after it was last written.
          </p>
        </>
      ) : here?.key === "needs" ? (
        <Group title="Needs you" count={view.needsYou.of} warn aside={closureHelp}>
          {listing.rows.length === 0 ? (
            <NothingHere listing={listing} />
          ) : (
            <ToldRows
              told={view.needsYou}
              label="Orders that need you"
              marked={marked}
              closing={(order) => (
                <CloseInRow
                  row={order}
                  marked={marked}
                  pressed={view.pressed}
                  place={listing.place}
                />
              )}
            />
          )}
          <CutNote cut={listing.cut} />
        </Group>
      ) : (
        <>
          {view.needsYou.of === 0 ? null : (
            <Group title="Needs you" count={view.needsYou.of} warn aside={closureHelp}>
              <ToldList
                told={view.needsYou}
                label="Orders that need you"
                marked={marked}
                {...(needs === undefined ? {} : { all: needs.to })}
              />
            </Group>
          )}
          {view.waitsOnTheBuyer.of === 0 ? null : (
            <Group title="Waiting on the buyer" count={view.waitsOnTheBuyer.of}>
              <ToldList
                told={view.waitsOnTheBuyer}
                label="Orders waiting on the buyer"
                marked={marked}
              />
            </Group>
          )}
          <OrderList view={view} />
        </>
      )}
      {note}
    </>
  );
}

/**
 * A closure's answer where the orders could not be read after it: what was
 * typed is kept on the page, since no form is drawn to keep it in. Only a
 * note refused before it was sent can be said to have closed nothing.
 */
export function ClosureUnlistedScreen({ view }: Readonly<{ view: ClosureUnlisted }>) {
  const { note, refusal, typed } = view.pressed;
  return (
    <NotLoaded again={view.again}>
      <div className="what">{note ?? refusal}</div>
      {typed === "" ? null : (
        <>
          <p className="why">The note you typed:</p>
          <p className="why words">{typed}</p>
        </>
      )}
      <p className="why">
        {note === null
          ? "Nothing was closed. Your orders could not be loaded."
          : "Your orders could not be loaded."}
      </p>
    </NotLoaded>
  );
}
