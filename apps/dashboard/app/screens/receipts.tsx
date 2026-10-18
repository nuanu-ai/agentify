import { Fragment } from "react";
import type { ReceiptsView, TransferView } from "../../src/views.js";
import { Ident, shortened } from "../components/copy.js";
import { Cell, DayHeading, List, ListEmpty, Row, RowMore } from "../components/list.js";
import { Moment } from "../components/moment.js";
import { Word } from "../components/word.js";
import { SharesOf, TestMark } from "./orders.js";
import styles from "./orders.module.css";

/** An arrow out of a box, for a page on another site. */
const Out = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

/**
 * The transfer behind a receipt, short with its copy button, and where this
 * deployment has the chain's page for it, a way there; a receipt without one
 * says only that this receipt does not carry it.
 */
const Transfer = ({ transfer }: Readonly<{ transfer: TransferView }>) =>
  transfer.kind === "none" ? (
    <span className="quiet">Not on this receipt</span>
  ) : (
    <span className="transfer">
      <Ident value={transfer.text} what="transfer" />
      {transfer.kind === "link" ? (
        <a
          className="copy"
          href={transfer.href}
          rel="noreferrer"
          aria-label={`See the transfer ${shortened(transfer.text)} on the chain's explorer`}
          title="See it on the chain's explorer"
        >
          <Out />
        </a>
      ) : null}
    </span>
  );

export function ReceiptsScreen({ view }: Readonly<{ view: ReceiptsView }>) {
  return (
    <>
      <div className="lede">
        <div>
          {view.testWarning === null ? null : <p className="problem">{view.testWarning}</p>}
        </div>
      </div>
      {/* Two tiles and not three. A third counting what is paid for and not yet
          delivered would read nought forever — a receipt is written only when
          goods are released — and a nought is a positive claim that there is
          none, printed where a merchant looks for money they are owed. What
          cannot be counted here is said in words under the tiles instead,
          with the place it can be counted. */}
      <div className="summary">
        <div className="tile">
          <div className="label">Receipts</div>
          <div className="figure">{view.count}</div>
          <div className="aside">{view.sums}</div>
        </div>
        <div className="tile">
          <div className="label">Delivered or shipped</div>
          <div className={view.delivered === 0 ? "figure" : "figure ok"}>{view.delivered}</div>
          <div className="aside">{view.ofCount}</div>
        </div>
      </div>
      <div className="summary-text">
        <p>
          A receipt appears when the product is released to the buyer, or a parcel is handed to a
          carrier. It shows the amount and three times. Paid is when the payment went through. Price
          set is when Agentify fixed the price for this sale. Price as of is when that price was
          true: the moment your price check said it held from, or, for a card sold at its own price,
          when the card was published with it. When the price is checked at the purchase, these
          times can be minutes apart.{" "}
          <a href="/docs/money#what-proves-a-sale-happened">
            What a receipt records, and what each of its times is
          </a>
          .
        </p>
        <p>
          This page does not show all of your money. Payments for products not yet delivered and
          refunds you owe are on Orders. A purchase that was never paid leaves no receipt, and no
          receipt appears while it is unknown whether the buyer was charged.
        </p>
      </div>
      {view.rows.length === 0 ? (
        <ListEmpty>No receipts yet. One appears when a product is released to the buyer.</ListEmpty>
      ) : (
        <List
          label="Receipts"
          columns="6rem minmax(12rem, 1fr) 9.5rem 9rem 11rem"
          head={["Paid", "Product", { text: "Amount", end: true }, "Outcome", "Transfer"]}
        >
          {view.rows.map((row, at) => (
            <Fragment key={row.id}>
              {row.day === view.rows[at - 1]?.day ? null : (
                <DayHeading level={2}>{row.day}</DayHeading>
              )}
              <Row needsYou={row.needsYou}>
                <Cell at="fact">{"time" in row.paid ? row.paid.time : row.paid.text}</Cell>
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
                  <Word word={row.outcome} />
                </Cell>
                <Cell at="ident">
                  <Transfer transfer={row.transfer} />
                </Cell>
                <RowMore summary="Receipt, order and price times" of={row.product} wide>
                  <div>
                    Receipt <Ident value={row.id} what="receipt ID" whole />
                  </div>
                  <div>
                    Order <Ident value={row.orderId} what="order ID" whole />
                  </div>
                  <SharesOf shares={row.shares} />
                  <div className="under">
                    Paid <Moment at={row.paid} />
                  </div>
                  <div className="under">
                    Price set <Moment at={row.priceSet} />
                  </div>
                  <div className="under">
                    Price as of <Moment at={row.priceAsOf} />
                  </div>
                </RowMore>
              </Row>
            </Fragment>
          ))}
        </List>
      )}
    </>
  );
}
