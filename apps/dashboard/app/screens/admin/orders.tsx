/**
 * The workspace's Orders, one order's page and the lookup's answer, drawn
 * from their views and nothing else. The pages run no script: a search and a
 * filter are forms that read, a segment is a link, and an identifier opens to
 * its whole value where the browser opens a `details`.
 */

import { Fragment } from "react";
import { Link } from "react-router";
import type {
  FindView,
  IdentView,
  OrderPageView,
  OrdersListView,
  OrderView,
  StepView,
  Toned,
} from "../../../src/admin/orders-view.js";
import {
  BOUNDARY,
  FIND_READS,
  ORDERS_NOTE,
  segmentInAddress,
  TIMELINE_NOTE,
} from "../../../src/admin/orders-view.js";
import { useChrome } from "../../answer.js";
import { CouldNotBeRead, OrderState } from "../../components/admin/unknown.js";
import { shortened } from "../../components/copy.js";
import { Cell, DayHeading, List, ListEmpty } from "../../components/list.js";
import { Pager } from "../../components/listing.js";
import { Moment } from "../../components/moment.js";
import { Word } from "../../components/word.js";
import styles from "./orders.module.css";

/** An identifier shown short in the monospaced face, opening to its whole value. */
function Whole({ value }: Readonly<{ value: string }>) {
  const short = shortened(value);
  return (
    <span className="ident">
      {short === value ? (
        <span>{value}</span>
      ) : (
        <details className="ident-whole">
          <summary title={value}>{short}</summary>
          <span className="ident-all">{value}</span>
        </details>
      )}
    </span>
  );
}

function OnTheChain({ ident }: Readonly<{ ident: IdentView }>) {
  return (
    <>
      <Whole value={ident.whole} />
      {ident.page === null ? null : (
        <>
          {" · "}
          <a href={ident.page}>on {new URL(ident.page).host}</a>
        </>
      )}
    </>
  );
}

function Badge({ toned }: Readonly<{ toned: Toned }>) {
  return toned.tone === "unknown" ? (
    <span className="badge badge-unknown">{toned.text}</span>
  ) : (
    <Word word={{ text: toned.text, tone: toned.tone }} />
  );
}

const Unread = ({ again }: Readonly<{ again: string }>) => (
  <ListEmpty>
    <p>
      <CouldNotBeRead /> The orders could not be read. <a href={again}>Read this page again</a>.
    </p>
  </ListEmpty>
);

export function OrdersScreen({ view }: Readonly<{ view: OrdersListView }>) {
  const { base } = useChrome();
  const { result } = view;
  return (
    <>
      <p className="op-asof">{view.readAt}</p>
      <form className="list-tools" method="get" action={`${base}/admin/orders`}>
        <search className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            name="q"
            aria-label="Search orders"
            placeholder="Search by order ID, product or transaction"
            defaultValue={view.q}
          />
        </search>
        {view.show === "all" ? null : (
          <input type="hidden" name="segment" value={segmentInAddress(view.show)} />
        )}
        <div className="field">
          <label className="field-label sr-only" htmlFor="by-merchant">
            Merchant
          </label>
          <select
            className="field-input"
            id="by-merchant"
            name="merchant"
            defaultValue={view.merchantId ?? ""}
          >
            <option value="">Every merchant</option>
            {view.merchants === null && view.merchantId !== null ? (
              <option value={view.merchantId}>{view.merchantId}</option>
            ) : null}
            {(view.merchants ?? []).map((merchant) => (
              <option key={merchant.id} value={merchant.id}>
                {merchant.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button button-secondary">
          Show
        </button>
      </form>
      <nav className={`segments ${styles.segments}`} aria-label="Show">
        {view.segments.map((segment) => {
          const words = (
            <>
              {segment.label}
              {segment.count === null ? null : (
                <>
                  {" "}
                  <b>{segment.count}</b>
                </>
              )}
            </>
          );
          return segment.here ? (
            <span key={segment.key} className="here" aria-current="page">
              {words}
            </span>
          ) : (
            <Link key={segment.key} to={segment.to}>
              {words}
            </Link>
          );
        })}
      </nav>
      {result.kind === "unread" ? (
        <Unread again={`${base}/admin/orders`} />
      ) : result.kind === "none" ? (
        <ListEmpty>
          <p>
            {result.said}
            {result.clear === null ? null : (
              <>
                {" "}
                <Link to={result.clear}>Clear the search and the merchant</Link>
              </>
            )}
          </p>
        </ListEmpty>
      ) : (
        <>
          <div className="list-box op-cols-orders">
            <ul className="list" aria-label="Orders">
              <li className="list-head" aria-hidden="true">
                <span>Price set</span>
                <span>Product · Merchant</span>
                <span>State</span>
                <span>Payment</span>
                <span className="end">Amount</span>
              </li>
              {result.rows.map((row, at) => (
                <Fragment key={row.id}>
                  {row.day === result.rows[at - 1]?.day ? null : (
                    <DayHeading level={2}>{row.day}</DayHeading>
                  )}
                  <li className="list-row">
                    <Cell at="fact">
                      {row.priced === null
                        ? "Not priced"
                        : "time" in row.priced
                          ? row.priced.time
                          : row.priced.text}
                    </Cell>
                    <Cell at="title">
                      <Link to={row.to}>{row.product}</Link>
                      <span className="op-sub">{row.merchant}</span>
                    </Cell>
                    <Cell at="state">
                      <OrderState word={row.state} />
                    </Cell>
                    <Cell at="state">
                      <Badge toned={row.payment} />
                    </Cell>
                    <Cell at="amount">{row.amount ?? "No price"}</Cell>
                  </li>
                </Fragment>
              ))}
            </ul>
          </div>
          <Pager
            range={result.cut}
            previous={{ to: result.newest, words: "Newest" }}
            next={{ to: result.earlier, words: "Earlier" }}
          />
        </>
      )}
      <p className="note">{ORDERS_NOTE}</p>
    </>
  );
}

function Step({ step }: Readonly<{ step: StepView }>) {
  return (
    <li>
      <span className={step.dot === null ? "dot" : `dot ${step.dot}`} />
      <div className="ev">
        <span className="who">{step.who}</span>
        <b>{step.what}</b>
        {step.said === null ? null : <p>{step.said}</p>}
      </div>
      <time>{step.at === null ? "time not recorded" : <Moment at={step.at} />}</time>
    </li>
  );
}

function OneOrder({ view }: Readonly<{ view: OrderView }>) {
  const { payment, receipt } = view;
  return (
    <>
      <div className="op-facts-line">
        <OrderState word={view.state} />
        <span className="mono">{view.amount ?? "No price"}</span>
        <Link to={view.merchant.to}>{view.merchant.name}</Link>
        <span>{view.card}</span>
        <Whole value={view.id} />
        <span className="op-asof">{view.readAt}</span>
      </div>

      <div className="op-voices">
        <div className="op-voice">
          <p className="label">What the agent reads</p>
          <p>
            <code>status: {view.agent.status}</code> ·{" "}
            <code>payment_status: {view.agent.paymentStatus}</code>
          </p>
          {view.agent.reason === null ? null : <p>Agentify's reason: “{view.agent.reason}”</p>}
          {view.agent.sellerWords === null ? null : (
            <p>The seller's words, as theirs: “{view.agent.sellerWords}”</p>
          )}
        </div>
        <div className="op-voice">
          <p className="label">{view.merchantSide.heading}</p>
          <p>
            <Word word={view.merchantSide.state} /> · Payment: {view.merchantSide.payment}
          </p>
          {view.merchantSide.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </div>

      <div className="op-two">
        <section className="op-panel" aria-labelledby="story-title">
          <div className="op-panel-head">
            <h2 id="story-title">What happened</h2>
            <p>Oldest first · times in UTC</p>
          </div>
          <div className="op-panel-body">
            <ol className="op-timeline">
              {view.timeline.map((step, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the steps never reorder, and two may say the same
                <Step key={at} step={step} />
              ))}
            </ol>
          </div>
          <p className="op-panel-foot">{TIMELINE_NOTE}</p>
        </section>

        <div>
          <section className="op-panel" aria-labelledby="payment-title">
            <div className="op-panel-head">
              <h2 id="payment-title">Payment</h2>
              <p>
                <Badge toned={payment.head} />
              </p>
            </div>
            <div className="op-panel-body">
              <dl className="more-facts">
                <div>
                  <dt>Amount</dt>
                  <dd>{payment.amount ?? "No price was named"}</dd>
                </div>
                <div>
                  <dt>Paid into</dt>
                  <dd>
                    {payment.paidInto === null ? (
                      "No payment was verified"
                    ) : (
                      <OnTheChain ident={payment.paidInto} />
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Transaction</dt>
                  <dd>
                    {payment.transaction === null ? (
                      "None recorded"
                    ) : (
                      <OnTheChain ident={payment.transaction} />
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Attempt</dt>
                  <dd>{payment.attempt}</dd>
                </div>
                <div>
                  <dt>Recorded about the payment</dt>
                  <dd>
                    {payment.words.length === 0 ? "Nothing recorded." : null}
                    {payment.words.map((word) => (
                      <span key={word} className="op-sub">
                        {word}
                      </span>
                    ))}
                    <span className="op-sub">{payment.dropped}</span>
                  </dd>
                </div>
                {payment.unknown === null ? null : (
                  <div>
                    <dt>Outcome</dt>
                    <dd>{payment.unknown}</dd>
                  </div>
                )}
                {payment.recovery === null ? null : (
                  <div>
                    <dt>Recovery</dt>
                    <dd>
                      {payment.recovery.hint === null ? (
                        "Holds no transaction to look for."
                      ) : (
                        <>
                          Looks for <OnTheChain ident={payment.recovery.hint} />, a hint and no
                          evidence that money moved.
                        </>
                      )}
                      {payment.recovery.nextBlock === null
                        ? null
                        : ` Its next search starts at block ${payment.recovery.nextBlock}.`}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </section>

          <section className="op-panel" aria-labelledby="receipt-title">
            <div className="op-panel-head">
              <h2 id="receipt-title">Receipt</h2>
              <p>{receipt.head}</p>
            </div>
            <div className="op-panel-body">
              {receipt.said === null ? null : <p className="op-sub">{receipt.said}</p>}
              {receipt.facts.length === 0 ? null : (
                <dl className="more-facts">
                  {receipt.facts.map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>
                        <Whole value={fact.value} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </section>

          <section className="op-panel" aria-labelledby="withheld-title">
            <div className="op-panel-head">
              <h2 id="withheld-title">Not shown here</h2>
            </div>
            <div className="op-panel-body">
              <p className="op-sub">{view.withheld}</p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export function OrderScreen({ view }: Readonly<{ view: OrderPageView }>) {
  const { base } = useChrome();
  return (
    <>
      <Link className="op-back" to="/admin/orders">
        ← All orders
      </Link>
      {view.kind === "order" ? (
        <OneOrder view={view} />
      ) : view.kind === "none" ? (
        <ListEmpty>
          <p>
            There is no order <Whole value={view.id} /> on this channel.
          </p>
        </ListEmpty>
      ) : (
        <ListEmpty>
          <p>
            <CouldNotBeRead /> The order <Whole value={view.id} /> could not be read.{" "}
            <a href={`${base}/admin/orders/${encodeURIComponent(view.id)}`}>Read this page again</a>
            .
          </p>
        </ListEmpty>
      )}
      <p className="op-bound">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16.5v.5" />
        </svg>
        <span>{BOUNDARY}</span>
      </p>
    </>
  );
}

export function FindScreen({ view }: Readonly<{ view: FindView }>) {
  const { base } = useChrome();
  return (
    <>
      <form className="list-tools" method="get" action={`${base}/admin/find`}>
        <search className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            name="q"
            aria-label="Find a record"
            placeholder="Paste an order ID, merchant ID, transaction, address, email or site"
            defaultValue={view.q}
          />
        </search>
        <button type="submit" className="button button-secondary">
          Find
        </button>
      </form>
      {view.kind === "asked" ? (
        <p className="note">{FIND_READS}</p>
      ) : view.kind === "unread" ? (
        <ListEmpty>
          <p>
            <CouldNotBeRead /> The records could not be searched.{" "}
            <a href={`${base}/admin/find?${new URLSearchParams({ q: view.q })}`}>Search again</a>.
          </p>
        </ListEmpty>
      ) : view.kind === "none" ? (
        <ListEmpty>
          <p>{view.said}</p>
          {view.unknown === null ? null : (
            <p>
              {view.unknown}{" "}
              <Link to="/admin/orders?segment=payment-unknown">
                Payments whose outcome is unknown
              </Link>
            </p>
          )}
        </ListEmpty>
      ) : (
        <List label={`Records matching ${view.q}`} columns="6.5rem minmax(0, 1fr) 11rem">
          {view.found.map((found) => (
            <li key={`${found.kind} ${found.id}`} className="list-row">
              <Cell at="state">
                <span className="badge badge-quiet">{found.kind}</span>
              </Cell>
              <Cell at="title">
                <Link to={found.to}>{found.label}</Link>
                <span className="op-sub">Matched by {found.by}</span>
              </Cell>
              <Cell at="ident">
                <Whole value={found.id} />
              </Cell>
            </li>
          ))}
        </List>
      )}
    </>
  );
}
