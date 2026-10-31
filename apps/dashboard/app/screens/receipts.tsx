import { Fragment } from "react";
import { Link } from "react-router";
import type { ReceiptsView } from "../../src/views.js";
import { Fact, Facts } from "../components/list.js";
import { Moment } from "../components/moment.js";
import { Word } from "../components/word.js";
import { Ident } from "../display/copy.js";
import { Cell, DayHeading, Group, List, ListEmpty } from "../display/list.js";
import { DisclosedRow } from "./disclosed-row.js";
import { CutNote } from "./listing.js";
import styles from "./orders.module.css";
import { Transfer } from "./transfer.js";

/**
 * When it was paid, the product, the outcome, the transfer, the amount and the
 * chevron; the product takes what the others leave and wraps.
 */
const RECEIPT_COLUMNS = "7rem minmax(0, 1fr) 8rem 10.5rem 8.5rem 1rem";

export function ReceiptsScreen({ view }: Readonly<{ view: ReceiptsView }>) {
  const { listing } = view;
  return (
    <>
      <Group title="All receipts" count={listing.segments[0]?.count ?? listing.rows.length}>
        {listing.rows.length === 0 ? (
          <ListEmpty>No receipts yet.</ListEmpty>
        ) : (
          <List
            label="Receipts"
            columns={RECEIPT_COLUMNS}
            head={["Paid", "Product", "Outcome", "Transfer", { text: "Amount", end: true }, ""]}
          >
            {listing.rows.map((row, at) => (
              <Fragment key={row.id}>
                {row.day === listing.rows[at - 1]?.day ? null : <DayHeading>{row.day}</DayHeading>}
                <DisclosedRow
                  of={{ title: row.product, day: row.day, time: row.time, id: row.id }}
                  id={`details-${row.id}`}
                  needsYou={row.needsYou}
                  cells={
                    <>
                      <Cell at="fact">{row.time}</Cell>
                      <Cell at="title">{row.product}</Cell>
                      <Cell at="state">
                        <Word word={row.outcome} />
                      </Cell>
                      <Cell at="ident">
                        {/* A receipt without one says only that this receipt does not carry it. */}
                        {row.transfer.kind === "none" ? (
                          <span className="quiet">Not on this receipt</span>
                        ) : (
                          <Transfer transfer={row.transfer} />
                        )}
                      </Cell>
                      <Cell at="amount">{row.amount}</Cell>
                    </>
                  }
                >
                  <div className={styles.details}>
                    <Facts>
                      <Fact label="Receipt">
                        <Ident value={row.id} what="receipt ID" whole />
                      </Fact>
                      <Fact label="Order">
                        <Ident value={row.orderId} what="order ID" whole />
                      </Fact>
                      {row.share === null ? null : <Fact label="Your share">{row.share}</Fact>}
                      <Fact label="Price set">
                        <Moment at={row.priceSet} />
                      </Fact>
                      <Fact label="Price as of">
                        <Moment at={row.priceAsOf} />
                      </Fact>
                    </Facts>
                  </div>
                </DisclosedRow>
              </Fragment>
            ))}
          </List>
        )}
        <CutNote cut={listing.cut} />
      </Group>
      <p className="note">
        Only delivered or shipped sales have a receipt. Paid orders still waiting for delivery are
        on <Link to="/orders">Orders</Link>.{" "}
        <a href="/docs/orders#the-receipt">What a receipt records</a>
      </p>
    </>
  );
}
