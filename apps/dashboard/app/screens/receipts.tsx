import { Table } from "@agentify/ui";
import type { ReceiptsView, TransferView } from "../../src/views.js";
import { Moment } from "../components/moment.js";
import { Word } from "../components/word.js";
import { TestMark } from "./orders.js";

const transferCell = (transfer: TransferView) =>
  transfer.kind === "none"
    ? { className: "quiet", content: "Not on this receipt" }
    : transfer.kind === "link"
      ? {
          className: "ident",
          content: (
            <a href={transfer.href} rel="noreferrer">
              {transfer.text}
            </a>
          ),
        }
      : { className: "ident", content: transfer.text };

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
            What a receipt records, and which moment each column is
          </a>
          .
        </p>
        <p>
          This page does not show all of your money. Payments for products not yet delivered and
          refunds you owe are on Orders. A purchase that was never paid leaves no receipt, and no
          receipt appears while it is unknown whether the buyer was charged.
        </p>
      </div>
      <Table
        columns={[
          "Receipt",
          "Order",
          "Product",
          "Amount",
          "Outcome",
          "Paid",
          "Price set",
          "Price as of",
          "Transfer",
        ]}
        empty="No receipts yet. One appears when a product is released to the buyer."
        rows={view.rows.map((row) => ({
          key: row.id,
          ...(row.needsYou ? { className: "needs-you" } : {}),
          cells: [
            { className: "ident", content: row.id },
            { className: "ident", content: row.orderId },
            { content: row.product },
            {
              className: "amount",
              content: (
                <>
                  {row.amount}
                  <TestMark test={row.test} />
                </>
              ),
            },
            { content: <Word word={row.outcome} /> },
            { className: "quiet moment", content: <Moment at={row.paid} /> },
            { className: "quiet moment", content: <Moment at={row.priceSet} /> },
            { className: "quiet moment", content: <Moment at={row.priceAsOf} /> },
            transferCell(row.transfer),
          ],
        }))}
      />
    </>
  );
}
