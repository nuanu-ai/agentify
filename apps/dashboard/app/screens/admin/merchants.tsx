/**
 * The workspace's Merchants list and one merchant's page, drawn from their
 * views alone. Every action is a form that posts with no script and is
 * answered with the page in its new state; an action that asks for more opens
 * in place, in a disclosure, so it reads the same on a phone and to a screen
 * reader. Identifiers are shown short and open to their whole value, ready to
 * select.
 */

import { Link } from "react-router";
import type { ActionAnswer } from "../../../src/admin/action.js";
import type {
  KeyLine,
  MerchantListRow,
  MerchantsView,
  MerchantView,
  SellingDayView,
} from "../../../src/admin/merchants.js";
import {
  ACCOUNTS_CUT,
  ACCOUNTS_UNREAD,
  boundSaid,
  DOT_EXPLAINED_SANDBOX,
  DOTS_EXPLAINED_LIVE,
  DOTS_EXPLAINED_TEST,
  READY_SAID_LIVE,
  READY_SAID_TEST,
  SORTED,
  WITHDRAWAL_NOTE,
} from "../../../src/admin/merchants-words.js";
import { LOST_ANSWER } from "../../../src/admin/words.js";
import { ActionForm } from "../../components/admin/action-form.js";
import { StepUp } from "../../components/admin/step-up.js";
import { CouldNotBeRead, OrderState } from "../../components/admin/unknown.js";
import { shortened } from "../../components/copy.js";
import { CutNote, ListTools, NothingHere } from "../../components/listing.js";
import { Moment } from "../../components/moment.js";
import { Word } from "../../components/word.js";
import { JournalList } from "./journal.js";

/** An identifier shown short that opens to its whole value; no copy button, since the workspace runs no script. */
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

/** An address whole, in groups of four, so a wrong one never looks like the right one. */
function Address({ address }: Readonly<{ address: string }>) {
  return (
    <span className="address">
      <span className="lead">{address.slice(0, 2)}</span>
      {(address.slice(2).match(/.{1,4}/g) ?? []).map((group, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the groups of one address never reorder
        <span className="quad" key={at}>
          {group}
        </span>
      ))}
    </span>
  );
}

const Tick = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12 5 5 9-10" />
  </svg>
);

// --- the list -----------------------------------------------------------------

function Row({ row }: Readonly<{ row: MerchantListRow }>) {
  return (
    <li className="list-row">
      <div className="cell cell-title">
        <Link to={row.href} prefetch="intent">
          {row.name}
        </Link>
        {row.under === null ? null : <span className="op-sub">{row.under}</span>}
      </div>
      <div className="cell cell-ident">
        <span>{row.integration}</span>
        <span className="op-sub">
          {row.connection.said}
          {row.connection.at === null ? null : (
            <>
              {" "}
              <Moment at={row.connection.at} />
            </>
          )}
        </span>
      </div>
      <div className="cell cell-fact">
        <span className="pips" aria-hidden="true">
          {row.dots.map((held, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the dots are the checks, in their one order
            <i key={at} className={held ? "on" : ""} />
          ))}
        </span>
        <span className="pips-said">{row.dotsSaid}</span>
      </div>
      <div className="cell cell-amount num">
        <span className="said-on-narrow">On sale </span>
        {row.cards}
      </div>
      <div className="cell cell-note num">
        <span className="said-on-narrow">Last 30 days </span>
        <span>{row.sales ?? "—"}</span>
        <span className="op-sub">
          {row.orders}
          {row.lastSale === null ? null : (
            <>
              {" · last sale "}
              <Moment at={row.lastSale} />
            </>
          )}
        </span>
      </div>
      <div className="cell cell-state">
        <Word word={row.state} />
      </div>
    </li>
  );
}

export function MerchantsScreen({ view }: Readonly<{ view: MerchantsView }>) {
  const live = view.mode === "live";
  const { listing } = view;
  return (
    <>
      <ListTools
        listing={listing}
        path="/admin/merchants"
        label="Search merchants"
        placeholder="Search by name, site or account email"
      />
      {view.accountsUnread ? <p className="problem">{ACCOUNTS_UNREAD}</p> : null}
      {view.accountsCut ? <p className="search-cut">{ACCOUNTS_CUT}</p> : null}
      {listing.rows.length === 0 && listing.nothing === null ? (
        <p className="quiet">No merchant has been made on this channel yet.</p>
      ) : (
        <>
          <NothingHere listing={listing} />
          {listing.rows.length === 0 ? null : (
            <div className="list-box op-cols-merchants">
              <ul
                className="list"
                aria-label={live ? "Merchants on the live channel" : "Merchants on this channel"}
              >
                <li className="list-head" aria-hidden="true">
                  <span>Merchant</span>
                  <span>Integration</span>
                  <span>Ready to sell</span>
                  <span className="num">On sale</span>
                  <span className="num">30 days</span>
                  <span>State</span>
                </li>
                {listing.rows.map((row) => (
                  <Row key={row.id} row={row} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <CutNote cut={listing.cut} />
      <p className="cut">
        <span>{SORTED}</span>
      </p>
      <p className="note">
        {live
          ? DOTS_EXPLAINED_LIVE
          : view.mode === "test"
            ? DOTS_EXPLAINED_TEST
            : DOT_EXPLAINED_SANDBOX}{" "}
        <span className="op-asof">Read </span>
        <Moment at={view.readAt} />
      </p>
    </>
  );
}

// --- one merchant ---------------------------------------------------------------

/** Settled sales per day as a line over thirty days, its numbers in its label for a screen reader. */
function Sparkline({ days }: Readonly<{ days: readonly SellingDayView[] }>) {
  const amounts = days.map((day) => Number(day.amount));
  const most = Math.max(0, ...amounts);
  const x = (at: number) => 4 + (at * 312) / Math.max(1, days.length - 1);
  const y = (amount: number) => (most === 0 ? 58 : 58 - (amount / most) * 50);
  const points = amounts.map((amount, at) => `${x(at).toFixed(1)},${y(amount).toFixed(1)}`);
  const today = days.at(-1);
  const label = `Settled sales per day over ${days.length} days, at most ${
    most === 0 ? "nothing" : `${days[amounts.indexOf(most)]?.amount} USD`
  } a day, ${today === undefined || today.count === 0 ? "nothing" : `${today.amount} USD`} so far today`;
  return (
    <svg className="op-spark" viewBox="0 0 320 64" role="img" aria-label={label}>
      <polygon className="area" points={`4,58 ${points.join(" ")} 316,58`} />
      <line className="base" x1="4" y1="58" x2="316" y2="58" />
      <polyline className="line" points={points.join(" ")} />
      {today === undefined ? null : (
        <circle className="dot" cx="316" cy={y(Number(today.amount)).toFixed(1)} r="3.5" />
      )}
    </svg>
  );
}

function Check({
  title,
  held,
  badge,
  children,
}: Readonly<{ title: string; held: boolean; badge: string; children: React.ReactNode }>) {
  return (
    <li className={held ? undefined : "missing"}>
      <span className="mark">{held ? <Tick /> : null}</span>
      <span className="what">
        <b>{title}</b>
        {children}
      </span>
      <span className={held ? "badge badge-pass" : "badge badge-notice"}>{badge}</span>
    </li>
  );
}

/** An action that opens in place, opened already where it was just answered. */
function InPlace({
  summary,
  open,
  children,
}: Readonly<{ summary: string; open: boolean; children: React.ReactNode }>) {
  return (
    <details open={open}>
      <summary className="op-act">{summary}</summary>
      {children}
    </details>
  );
}

/**
 * The answer to a press whose form this page does not draw in its state now,
 * such as Admit pressed for a merchant already admitted: the step-up, the
 * refusal or the lost answer, so none goes unsaid. Done and unchanged need no
 * words here: the page in its new state is the answer.
 */
function Stray({ answer }: Readonly<{ answer: ActionAnswer | null }>) {
  if (answer === null || answer.kind === "done" || answer.kind === "unchanged") return null;
  if (answer.kind === "step-up") {
    return (
      <div className="op-decide">
        <StepUp view={answer.stepUp} />
      </div>
    );
  }
  return (
    <p className="problem" role="alert">
      {answer.kind === "refused" ? answer.said : LOST_ANSWER}
    </p>
  );
}

function KeyItem({
  line,
  called,
  path,
}: Readonly<{ line: KeyLine; called: string; path: string }>) {
  return (
    <li>
      <span>
        <span className="k">{line.label}</span> <Whole value={line.id} /> · issued{" "}
        <Moment at={line.issued} /> ·{" "}
        {line.lastUsed === null ? (
          "no use recorded"
        ) : (
          <>
            last used <Moment at={line.lastUsed} />
          </>
        )}
        {line.disabled === null ? null : (
          <>
            {" "}
            · disabled <Moment at={line.disabled} />
          </>
        )}
      </span>
      {line.disabled !== null ? (
        <>
          <span className="badge badge-quiet">
            {line.answer?.kind === "done" ? "Disabled just now" : "Disabled"}
          </span>
          <Stray answer={line.answer} />
        </>
      ) : (
        <>
          <span className="badge badge-pass">Works</span>
          <InPlace summary="Disable…" open={line.answer !== null}>
            <ActionForm
              action={`${path}/keys/${line.id}/disable`}
              title={`Disable the key "${line.label}"`}
              button="Disable the key"
              consequence={`Stop the key "${line.label}" working now. No other key and no session is touched; ${called} can issue a new key in its dashboard.`}
              reason
              answer={line.answer}
            />
          </InPlace>
        </>
      )}
    </li>
  );
}

export function MerchantScreen({ view }: Readonly<{ view: MerchantView }>) {
  const path = `/admin/merchants/${view.id}`;
  const { ready, selling } = view;
  const admission = ready.admission;
  const integration = ready.integration;
  return (
    <>
      <Link className="op-back" to="/admin/merchants">
        ← All merchants
      </Link>
      <div className="op-facts-line">
        <Word word={view.state} />
        {view.site === null ? null : <a href={view.site}>{new URL(view.site).host}</a>}
        <Whole value={view.id} />
        <span>
          {view.emails === null ? (
            <>
              Account <CouldNotBeRead />
            </>
          ) : view.emails.length === 0 ? (
            "No account names it"
          ) : (
            `Account ${view.emails.join(", ")}`
          )}
        </span>
        <span>
          Merchant since <Moment at={view.since} />
        </span>
        <span className="op-asof">
          Read <Moment at={view.readAt} />
        </span>
      </div>
      <div className="op-two">
        <section className="op-panel" aria-labelledby="ready-title">
          <div className="op-panel-head">
            <h2 id="ready-title">Ready to sell</h2>
            <p>{admission === null ? READY_SAID_TEST : READY_SAID_LIVE}</p>
          </div>
          <div className="op-panel-body">
            <ul className="op-checks">
              <Check
                title="Seller name"
                held={ready.sellerName !== null}
                badge={ready.sellerName === null ? "Missing" : "Set"}
              >
                <span>
                  {ready.sellerName === null
                    ? "Not set. Every card is off sale until the merchant chooses one in their dashboard."
                    : `${ready.sellerName}, as buyers and their agents read it`}
                </span>
              </Check>
              <Check
                title="Payout wallet"
                held={ready.wallet?.split != null}
                badge={
                  ready.wallet === null
                    ? "Missing"
                    : ready.wallet.split === null
                      ? "No split"
                      : "Set"
                }
              >
                {ready.wallet === null ? (
                  <span>Not set. Every card is off sale until the merchant sets one.</span>
                ) : (
                  <>
                    <Address address={ready.wallet.address} />
                    <span>
                      {ready.wallet.split === null ? (
                        "No payout split is recorded for this wallet, so it is read as no wallet and nothing of theirs is sold."
                      ) : (
                        <>
                          Pays out from the split <Whole value={ready.wallet.split} />
                          {ready.wallet.explorer === null ? null : (
                            <>
                              , <a href={ready.wallet.explorer}>on the explorer</a>
                            </>
                          )}
                          .
                        </>
                      )}{" "}
                      {ready.wallet.landsAt === null ? (
                        "No change of wallet waits."
                      ) : (
                        <>
                          A change of wallet waits and lands <Moment at={ready.wallet.landsAt} />.
                        </>
                      )}
                    </span>
                  </>
                )}
              </Check>
              <Check
                title="Integration"
                held={
                  integration.connection.at !== null ||
                  (integration.shop !== null && integration.shop !== "unread")
                }
                badge={
                  integration.connection.at !== null ||
                  (integration.shop !== null && integration.shop !== "unread")
                    ? "Connected"
                    : "Not connected"
                }
              >
                <span>
                  {integration.kind === "woocommerce"
                    ? "A WooCommerce shop connected from the dashboard."
                    : "Code against the SDK."}{" "}
                  {integration.connection.said}
                  {integration.connection.at === null ? null : (
                    <>
                      {" "}
                      <Moment at={integration.connection.at} />
                    </>
                  )}
                  . It is a fact here, not a condition of admission.
                </span>
                {integration.shop === "unread" ? (
                  <span>
                    The shop <CouldNotBeRead />
                  </span>
                ) : integration.shop === null ? null : (
                  <span>
                    Shop {integration.shop.url}, connected{" "}
                    <Moment at={integration.shop.connected} />, with {integration.shop.permissions}{" "}
                    permissions.
                  </span>
                )}
                {integration.keys.length === 0 ? null : (
                  <ul className="op-keys">
                    {integration.keys.map((line) => (
                      <KeyItem key={line.id} line={line} called={view.called} path={path} />
                    ))}
                  </ul>
                )}
                {integration.keysCut === null ? null : <span>{integration.keysCut}</span>}
              </Check>
              {admission === null ? null : (
                <Check
                  title="Admission to live sales"
                  held={admission.admittedAt !== null}
                  badge={admission.admittedAt === null ? "Not admitted" : "Admitted"}
                >
                  {admission.admittedAt !== null ? (
                    <>
                      <span>
                        Admitted <Moment at={admission.admittedAt} />
                        {admission.admittedBy === null ? "" : ` by ${admission.admittedBy}`}.
                      </span>
                      <InPlace summary="Withdraw admission…" open={admission.withdraw !== null}>
                        <ActionForm
                          action={`${path}/withdraw`}
                          title={`Withdraw ${view.called}'s admission`}
                          button="Withdraw admission"
                          consequence={`Take every ${view.called} card off sale on the live channel now. Orders already taken carry on, and nothing is refunded.`}
                          reason
                          reasonWords={WITHDRAWAL_NOTE}
                          answer={admission.withdraw}
                          secondary
                        />
                      </InPlace>
                      <Stray answer={admission.admit} />
                    </>
                  ) : (
                    <>
                      <span>
                        {admission.withdrawn === null ? (
                          "Not admitted."
                        ) : admission.withdrawn === "unread" ? (
                          <>
                            Not admitted. Whether a withdrawal stands, and the note the merchant
                            reads, <CouldNotBeRead />
                          </>
                        ) : (
                          <>
                            Withdrawn <Moment at={admission.withdrawn.at} /> by{" "}
                            {admission.withdrawn.by}
                            {admission.withdrawn.note === null
                              ? "."
                              : `. The merchant reads: “${admission.withdrawn.note}”`}
                          </>
                        )}
                      </span>
                      <ActionForm
                        action={`${path}/admit`}
                        button="Admit to live sales"
                        consequence={`Allow ${view.called} to sell for real money on the live channel. Its cards go on sale as soon as nothing else is missing; admission says nothing about payments or refunds, and it can be withdrawn here later, with a note.`}
                        answer={admission.admit}
                      />
                      <Stray answer={admission.withdraw} />
                    </>
                  )}
                </Check>
              )}
            </ul>
            <Stray answer={ready.strayAnswer} />
            {admission?.withdraw?.kind === "done" || admission?.admit?.kind === "done" ? (
              <p className="quiet" role="status">
                Done. The history below holds the row that recorded it.
              </p>
            ) : admission?.withdraw?.kind === "unchanged" ||
              admission?.admit?.kind === "unchanged" ? (
              <p className="quiet" role="status">
                It was so already; the history below holds the press.
              </p>
            ) : null}
          </div>
        </section>
        <div>
          <section className="op-panel" aria-labelledby="selling-title">
            <div className="op-panel-head">
              <h2 id="selling-title">Selling</h2>
              <p>Last 30 days</p>
            </div>
            <div className="op-panel-body">
              <dl className="op-kv">
                <div>
                  <dt>On sale</dt>
                  <dd>
                    {selling.onSale} of {selling.published}
                  </dd>
                </div>
                <div>
                  <dt>Settled</dt>
                  <dd>{selling.settled.amount}</dd>
                </div>
                <div>
                  <dt>Orders</dt>
                  <dd>{selling.orders}</dd>
                </div>
              </dl>
              <Sparkline days={selling.days} />
              <p className="op-sub">
                Settled sales per day in USD, {selling.settled.count}{" "}
                {selling.settled.count === 1 ? "sale" : "sales"} in all; the dot is today until the
                moment this page was read.
              </p>
              <h3>Orders worth a look</h3>
              {view.worth.rows.length === 0 ? (
                <p className="quiet">
                  No order of theirs has an unknown payment, is unfulfilled or waits for payment.
                </p>
              ) : (
                <ul className="op-mini">
                  {view.worth.rows.map((order) => (
                    <li key={order.id}>
                      <OrderState word={order.state} />
                      <Link to={order.href}>{order.title}</Link>
                      <span className="fig">{order.price}</span>
                      <span className="when">
                        <Moment at={order.when} /> ·{" "}
                        <span className="op-id">{shortened(order.id)}</span>
                        {order.shopUncertain
                          ? " · its shop order is uncertain; the merchant recovers it from their own Orders"
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {view.worth.cut === null ? null : <p className="op-sub">{view.worth.cut}</p>}
              {view.shopOrdersUnread ? (
                <p className="op-sub">
                  Which of these have a shop order nobody is sure of <CouldNotBeRead />
                </p>
              ) : null}
            </div>
          </section>
          <section className="op-panel" aria-labelledby="cards-title">
            <div className="op-panel-head">
              <h2 id="cards-title">Cards</h2>
              <p>
                {selling.onSale} of {selling.published} on sale
              </p>
            </div>
            <div className="op-panel-body">
              {view.cards.rows.length === 0 ? (
                <p className="quiet">No card is published.</p>
              ) : (
                <ul className="op-mini">
                  {view.cards.rows.map((card) => (
                    <li key={card.id}>
                      <span
                        className={
                          card.onSale
                            ? "badge badge-pass"
                            : card.paused
                              ? "badge badge-partial"
                              : "badge badge-quiet"
                        }
                      >
                        {card.onSale
                          ? "On sale"
                          : card.paused
                            ? "Paused by the merchant"
                            : "Off sale"}
                      </span>
                      <span>{card.title}</span>
                      <span className="fig">{card.price}</span>
                      <span className="when">
                        {card.timing} · {card.code}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {view.cards.cut === null ? null : <p className="op-sub">{view.cards.cut}</p>}
            </div>
          </section>
        </div>
      </div>
      <section className="group" aria-labelledby="history-title">
        <div className="group-head">
          <h2 id="history-title">History</h2>
          <p className="group-aside">
            From the journal · <Link to="/admin/journal">The whole journal</Link>
          </p>
        </div>
        {view.history === null ? (
          <p className="op-sub">
            The history <CouldNotBeRead />
          </p>
        ) : view.history.lines.length === 0 ? (
          <p className="op-sub">No administrative action on this merchant yet.</p>
        ) : (
          <JournalList
            lines={view.history.lines}
            label={`The journal's rows about ${view.called}`}
            onItsPage
          />
        )}
        {view.history?.cut == null ? null : <p className="cut">{view.history.cut}</p>}
      </section>
      <p className="op-bound">
        <span>{boundSaid(view.called)}</span>
      </p>
    </>
  );
}
