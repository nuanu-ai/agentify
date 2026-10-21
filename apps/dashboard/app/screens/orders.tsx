import { Button, Field } from "@agentify/ui";
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import type { ClosurePressed, ClosureUnlisted, OrdersView, ToldOrders } from "../../src/views.js";
import { Ident, shortened } from "../components/copy.js";
import {
  Cell,
  DayHeading,
  Fact,
  Facts,
  Group,
  List,
  ListEmpty,
  Row,
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

/**
 * An order that needs saying in full, in a row of its own: its state, its
 * product and its sum, then what happened and what is the merchant's to do,
 * then its ID and when its price was set, and the way to its details or its
 * closure; where `closure` is given, the closure opens in the row itself in
 * place of that way.
 */
const Told = ({
  order,
  closure,
}: Readonly<{ order: ToldOrders["rows"][number]; closure?: ReactNode }>) => (
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
      {closure === undefined ? (
        <Link
          to={{ pathname: "/orders", search: order.opens.search, hash: `#details-${order.id}` }}
        >
          {order.opens.words}
        </Link>
      ) : null}
      <span>
        Price set <Moment at={order.priceSet} />
      </span>
    </div>
    {closure}
  </li>
);

/** Orders told in full, a row of their own each, each with the closure `closing` draws for it. */
const ToldRows = ({
  told,
  label,
  closing,
}: Readonly<{
  told: ToldOrders;
  label: string;
  closing?: (order: ToldOrders["rows"][number]) => ReactNode;
}>) => (
  <List label={label} columns="1fr">
    {told.rows.map((order) => (
      <Told
        key={order.id}
        order={order}
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
  all,
}: Readonly<{ told: ToldOrders; label: string; all?: string }>) => (
  <>
    <ToldRows told={told} label={label} />
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
 * explanation.
 */
const CloseFulfillment = ({
  id,
  again,
  typed,
  refusal,
  place,
  headed = true,
}: Readonly<{
  id: string;
  again: boolean;
  typed: string;
  refusal: string | null;
  place: OrdersView["listing"]["place"];
  /** False where the control that opened the form already names the press. */
  headed?: boolean;
}>) => {
  const press = pressFor(again);
  return (
    <section className={styles.close} aria-label={press}>
      {headed ? <h3>{press}</h3> : null}
      <p className={styles.help}>
        {again
          ? "The payment arrived after you closed this order. Closing again records a new time and explanation; it moves no money."
          : "Stops delivery through Agentify for this order. It cannot be undone, and it cancels nothing in your shop and moves no money."}
      </p>
      <PostForm action="/orders" className="issue">
        {(pending) => (
          <>
            <input type="hidden" name="order_id" value={id} />
            <KeptPlace place={place} />
            <Field
              name="message"
              label="Explanation to the buyer (optional)"
              rows={3}
              maxLength={2000}
              autoComplete="off"
              defaultValue={typed}
              {...(refusal === null ? {} : { error: refusal })}
              hint="Shown to the buyer as your words; Agentify does not check them."
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

/**
 * What the row's columns do not show, opened from the row: drawn on a wide
 * row too only where there is something to read or do there, a closure, a
 * press, or a payment still unknown; elsewhere, as on every list, on a narrow
 * row alone.
 */
const OrderDetails = ({
  row,
  pressed,
  place,
}: Readonly<{
  row: OrdersView["listing"]["rows"][number];
  pressed: ClosurePressed | null;
  place: OrdersView["listing"]["place"];
}>) => {
  const said = pressed?.id === row.id ? pressed : null;
  // A refusal is said under the box it is about; with no form left, here.
  const told = said === null ? null : (said.note ?? (row.closing === null ? said.refusal : null));
  return (
    <RowMore
      summary="Order details"
      wide={row.closing !== null || row.closure !== null || row.paymentUnresolved || said !== null}
      id={`details-${row.id}`}
      open={row.opened || said !== null || undefined}
      of={row.product}
    >
      <div className={styles.details}>
        <Facts>
          <Fact label="Order ID">
            <Ident value={row.id} what="order ID" whole />
          </Fact>
          <Fact label="Payment">
            {row.payment}
            <TestMark test={row.test} />
          </Fact>
          <Fact label="Price set">
            <Moment at={row.priceSet} />
          </Fact>
          {row.shopTotal === null ? null : (
            <Fact label="Shop's order total">
              {row.shopTotal}, within a cent of what the buyer paid
            </Fact>
          )}
          {row.shares === null ? null : (
            <Fact label="Shares">
              {row.shares.merchant} to you
              <br />
              {row.shares.commission} to Agentify
            </Fact>
          )}
          {row.closure === null ? null : (
            <Fact label="Closed by you">
              <Moment at={row.closure.at} />
            </Fact>
          )}
          {row.closure?.message === undefined ? null : (
            <Fact label="Your explanation">
              <span className="words">{row.closure.message}</span>
            </Fact>
          )}
        </Facts>
        {row.paymentUnresolved ? (
          <p className={styles.help}>
            This payment may still complete. Closing fulfillment does not cancel it, and Agentify
            keeps checking it.
          </p>
        ) : null}
        {told === null ? null : (
          <p className="problem" role="alert">
            {told}
          </p>
        )}
        {said === null || said.typed === "" || row.closing !== null ? null : (
          <>
            <p className={styles.help}>The explanation you typed:</p>
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
    </RowMore>
  );
};

/** Every order the address asks for, a row each, with the details each opens. */
const OrderList = ({ view }: Readonly<{ view: OrdersView }>) => {
  const { listing } = view;
  const here = listing.segments.find((one) => one.here);
  const title = here?.key === "open" ? "Open orders" : "All orders";
  return (
    <Group title={title} count={here?.count ?? listing.rows.length}>
      {listing.rows.length === 0 ? (
        <NothingHere listing={listing} />
      ) : (
        <List
          label={title}
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
                <OrderDetails row={row} pressed={view.pressed} place={listing.place} />
              </Row>
            </Fragment>
          ))}
        </List>
      )}
      <CutNote cut={listing.cut} />
    </Group>
  );
};

/**
 * A closure opened from the row it closes, on a list whose rows already say
 * what the order's details would: named by the press it opens, and holding
 * what became of a press made on it.
 */
const CloseInRow = ({
  row,
  pressed,
  place,
}: Readonly<{
  row: OrdersView["listing"]["rows"][number];
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
    >
      <div className={styles.details}>
        {said?.note == null ? null : (
          <p className="problem" role="alert">
            {said.note}
          </p>
        )}
        <CloseFulfillment
          id={row.id}
          again={row.closing === "again"}
          typed={said?.typed ?? ""}
          refusal={said?.refusal ?? null}
          place={place}
          headed={false}
        />
      </div>
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
  const here = listing.segments.find((one) => one.here);
  const needs = listing.segments.find((one) => one.key === "needs");
  // The page's own links to an order search for its ID and open it; the
  // merchant searched for nothing there, so nothing is said of the search.
  const opening = listing.rows.some(
    (row) => row.opened && row.id.toLowerCase() === listing.search.q.toLowerCase(),
  );
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
        label="Search orders by ID or product"
        placeholder="Search by order ID or product"
        {...(opening
          ? {}
          : {
              searched: (q: string) =>
                `Only orders whose ID or product matches “${q}” are counted and shown.`,
            })}
      />
      {view.testNote === null ? null : <p className="problem">{view.testNote}</p>}
      {view.closedElsewhere === null ? null : (
        <p className="quiet">
          {`Fulfillment closed for ${shortened(view.closedElsewhere.id)} · `}
          <Link to={{ pathname: "/orders", search: view.closedElsewhere.opens }}>
            Order details
          </Link>
        </p>
      )}
      {here?.key === "needs" ? (
        <Group title="Needs you" count={view.needsYou.of} warn aside={closureHelp}>
          {listing.rows.length === 0 ? (
            <NothingHere listing={listing} />
          ) : (
            <ToldRows
              told={view.needsYou}
              label="Orders that need you"
              closing={(order) => (
                <CloseInRow row={order} pressed={view.pressed} place={listing.place} />
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
                {...(needs === undefined ? {} : { all: needs.to })}
              />
            </Group>
          )}
          {view.waitsOnTheBuyer.of === 0 ? null : (
            <Group title="Waiting on the buyer" count={view.waitsOnTheBuyer.of}>
              <ToldList told={view.waitsOnTheBuyer} label="Orders waiting on the buyer" />
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
 * typed is kept on the page, since no form is drawn to keep it in. Only an
 * explanation refused before it was sent can be said to have changed nothing.
 */
export function ClosureUnlistedScreen({ view }: Readonly<{ view: ClosureUnlisted }>) {
  const { note, refusal, typed } = view.pressed;
  return (
    <NotLoaded again={view.again}>
      <div className="what">{note ?? refusal}</div>
      {typed === "" ? null : (
        <>
          <p className="why">The explanation you typed:</p>
          <p className="why words">{typed}</p>
        </>
      )}
      <p className="why">Your orders could not be loaded.</p>
      {note === null ? (
        <p className="why">Nothing was closed, and loading them changed nothing.</p>
      ) : null}
    </NotLoaded>
  );
}
