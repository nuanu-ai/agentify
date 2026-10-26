/**
 * The workspace's Merchants list and one merchant's page, drawn from their
 * views alone. Every action is a form that posts with no script and is
 * answered with the page in its new state; an intervention opens in place, in
 * a disclosure under the thing it acts on, so it reads the same on a phone and
 * to a screen reader. Identifiers are shown short and open to their whole
 * value, ready to select.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";
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
  SORTED,
  WITHDRAWAL_NOTE,
} from "../../../src/admin/merchants-words.js";
import type { StepUpView } from "../../../src/admin/step-up.js";
import { ActionForm, InPlace, opensOn } from "../../components/admin/action-form.js";
import { PressAnswer } from "../../components/admin/press-answer.js";
import { CouldNotBeRead, OrderState } from "../../components/admin/unknown.js";
import { shortened } from "../../components/copy.js";
import { ListTools, NothingHere } from "../../components/listing.js";
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

/** A merchant's name at the head of a sentence: "this merchant" starts one as "This merchant". */
const opening = (called: string): string => `${called.slice(0, 1).toUpperCase()}${called.slice(1)}`;

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
        <span>
          <span className="said-on-narrow">Integration </span>
          {row.integration}
        </span>
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
        <span className="said-on-narrow">Missing </span>
        {row.missing}
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
        placeholder="Name, site or account email"
      />
      {view.accountsUnread ? <p className="problem">{ACCOUNTS_UNREAD}</p> : null}
      {view.accountsCut ? <p className="search-cut">{ACCOUNTS_CUT}</p> : null}
      {listing.rows.length === 0 && listing.nothing === null ? (
        <p className="quiet">No merchant has been made on this channel yet.</p>
      ) : (
        <>
          <NothingHere listing={listing} />
          {listing.rows.length === 0 ? null : (
            <>
              <div className="list-box op-cols-merchants">
                <ul
                  className="list"
                  aria-label={live ? "Merchants on the live channel" : "Merchants on this channel"}
                >
                  <li className="list-head" aria-hidden="true">
                    <span>Merchant</span>
                    <span>Integration</span>
                    <span>Missing</span>
                    <span className="num">On sale</span>
                    <span className="num">30 days</span>
                    <span>State</span>
                  </li>
                  {listing.rows.map((row) => (
                    <Row key={row.id} row={row} />
                  ))}
                </ul>
              </div>
              <p className="cut">
                <span>{view.cut}</span>
                <span>{SORTED}</span>
                <span>
                  Read <Moment at={view.readAt} />
                </span>
              </p>
            </>
          )}
        </>
      )}
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
}: Readonly<{ title: string; held: boolean; badge: string; children: ReactNode }>) {
  return (
    <li className={held ? undefined : "missing"}>
      <span className="mark">{held ? <Tick /> : null}</span>
      <div className="what">
        <b>{title}</b>
        {children}
      </div>
      <span className={held ? "badge badge-pass" : "badge badge-notice"}>{badge}</span>
    </li>
  );
}

function KeyItem({
  line,
  called,
  path,
  stepUp,
}: Readonly<{ line: KeyLine; called: string; path: string; stepUp: StepUpView | null }>) {
  const off = line.disabled !== null;
  return (
    <li className={off ? "op-key op-key-off" : "op-key"}>
      <div className="op-key-head">
        <span className="op-key-name">{line.label}</span>
        <Whole value={line.id} />
        <span className={off ? "badge badge-quiet" : "badge badge-pass"}>
          {off ? "Disabled" : "Works"}
        </span>
      </div>
      <p className="op-key-when">
        {line.lastUsed === null ? (
          "Never used"
        ) : (
          <>
            Last used <Moment at={line.lastUsed} />
          </>
        )}
        {" · issued "}
        <Moment at={line.issued} />
        {line.disabled === null ? null : (
          <>
            {" · disabled "}
            <Moment at={line.disabled} />
          </>
        )}
      </p>
      {off ? (
        <PressAnswer
          answer={line.answer}
          done="The key is disabled."
          unchanged="The key was disabled already; nothing changed."
          page={path}
        />
      ) : (
        <InPlace summary="Disable…" tone="destructive" open={opensOn(line.answer)}>
          <ActionForm
            action={`${path}/keys/${line.id}/disable`}
            page={path}
            title={`Disable the key “${line.label}”`}
            button="Disable the key"
            consequence={
              line.inUse && line.lastUsed !== null ? (
                <>
                  Stop the key “{line.label}” now. It was last used <Moment at={line.lastUsed} />:
                  if {called}'s worker runs on it, their sales stop until they switch to a new key.
                </>
              ) : (
                `Stop the key “${line.label}” now. ${opening(called)} can issue a new key in their dashboard.`
              )
            }
            reason
            answer={line.answer}
            tone="destructive"
            stepUp={stepUp}
          />
        </InPlace>
      )}
    </li>
  );
}

/** The accounts behind a merchant, each a way to its own page. */
function Accounts({ accounts }: Readonly<{ accounts: MerchantView["accounts"] }>) {
  if (accounts === null) {
    return (
      <span>
        Account <CouldNotBeRead />
      </span>
    );
  }
  if (accounts.length === 0) return <span>No account names it</span>;
  return (
    <span>
      {accounts.length === 1 ? "Account " : "Accounts "}
      {accounts.map((account, at) => (
        <span key={account.id}>
          {at === 0 ? null : ", "}
          <Link to={`/admin/accounts/${account.id}`}>{account.email}</Link>
        </span>
      ))}
    </span>
  );
}

function Admission({ view, path }: Readonly<{ view: MerchantView; path: string }>): ReactNode {
  const admission = view.ready.admission;
  if (admission === null) return null;
  const landsAt = view.ready.wallet?.landsAt ?? null;
  const called = view.called;
  return (
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
          <PressAnswer
            answer={admission.admit}
            done="Admitted to live sales."
            unchanged="It was admitted already; nothing changed."
            page={path}
          />
          <InPlace summary="Withdraw admission…" open={opensOn(admission.withdraw)}>
            <ActionForm
              action={`${path}/withdraw`}
              page={path}
              title="Withdraw admission"
              button="Withdraw admission"
              consequence={`All of ${called}'s products go off sale now. Open orders carry on; nothing is refunded.`}
              reason
              reasonWords={WITHDRAWAL_NOTE}
              answer={admission.withdraw}
              stepUp={view.stepUp}
            />
          </InPlace>
        </>
      ) : (
        <>
          <span>
            {admission.withdrawn === null ? (
              "Not admitted."
            ) : admission.withdrawn === "unread" ? (
              <>
                Not admitted. Whether a withdrawal stands, and the note the merchant reads,{" "}
                <CouldNotBeRead />
              </>
            ) : (
              <>
                Withdrawn <Moment at={admission.withdrawn.at} /> by {admission.withdrawn.by}
                {admission.withdrawn.note === null
                  ? "."
                  : `. The merchant reads: “${admission.withdrawn.note}”`}
              </>
            )}
          </span>
          <PressAnswer
            answer={admission.withdraw}
            done="Admission withdrawn."
            unchanged="It was not admitted; nothing changed."
            page={path}
          />
          <ActionForm
            action={`${path}/admit`}
            page={path}
            button="Admit to live sales"
            consequence={
              landsAt === null ? (
                `${opening(called)} sells for real money from now on. You can withdraw this later.`
              ) : (
                <>
                  {opening(called)} sells for real money from now on, and its payments go to a new
                  wallet from <Moment at={landsAt} />. You can withdraw this later.
                </>
              )
            }
            answer={admission.admit}
            tone="positive"
            stepUp={view.stepUp}
            beside={
              landsAt === null ? null : (
                <p className="op-beside">
                  <span className="badge badge-notice">Wallet change waiting</span>
                  <span>
                    The merchant changed their payout wallet; the new one takes over{" "}
                    <Moment at={landsAt} />.
                  </span>
                </p>
              )
            }
          />
        </>
      )}
    </Check>
  );
}

export function MerchantScreen({ view }: Readonly<{ view: MerchantView }>) {
  const path = `/admin/merchants/${view.id}`;
  const { ready, selling } = view;
  const { integration } = ready;
  const connected =
    integration.connection.at !== null ||
    (integration.shop !== null && integration.shop !== "unread");
  const journal = `/admin/journal?q=${encodeURIComponent(view.id)}`;
  return (
    <>
      <Link className="op-back" to="/admin/merchants">
        ← All merchants
      </Link>
      <div className="op-facts-line">
        <Word word={view.state} />
        {view.site === null ? null : <a href={view.site}>{new URL(view.site).host}</a>}
        <Whole value={view.id} />
        <Accounts accounts={view.accounts} />
        <span>
          Merchant since <Moment at={view.since} />
        </span>
        <span>
          Read <Moment at={view.readAt} />
        </span>
      </div>
      <div className="op-two">
        <div>
          <section className="op-panel" aria-labelledby="ready-title">
            <div className="op-panel-head">
              <h2 id="ready-title">Ready to sell</h2>
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
                      ? "Not set. No product is on sale until the merchant chooses one."
                      : ready.sellerName}
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
                    <span>Not set. No product is on sale until the merchant sets one.</span>
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
                        )}
                        {ready.wallet.landsAt === null ? null : (
                          <>
                            {" "}
                            A new wallet takes over <Moment at={ready.wallet.landsAt} />.
                          </>
                        )}
                      </span>
                    </>
                  )}
                </Check>
                <Admission view={view} path={path} />
              </ul>
              <PressAnswer answer={ready.strayAnswer} done="Done." page={path} />
            </div>
          </section>

          <section className="op-panel" aria-labelledby="integration-title">
            <div className="op-panel-head">
              <h2 id="integration-title">Integration</h2>
              <span className={connected ? "badge badge-pass" : "badge badge-quiet"}>
                {connected ? "Connected" : "Not connected"}
              </span>
            </div>
            <div className="op-panel-body">
              <p className="op-text">
                {integration.kind === "woocommerce"
                  ? "A WooCommerce shop."
                  : "Code against the SDK."}{" "}
                {integration.connection.said}
                {integration.connection.at === null ? null : (
                  <>
                    {" "}
                    <Moment at={integration.connection.at} />
                  </>
                )}
                .
              </p>
              {integration.shop === "unread" ? (
                <p className="op-text">
                  The shop <CouldNotBeRead />
                </p>
              ) : integration.shop === null ? null : (
                <p className="op-text">
                  Shop {integration.shop.url}, connected <Moment at={integration.shop.connected} />,
                  with {integration.shop.permissions} permissions.
                </p>
              )}
              {integration.keys.length === 0 ? null : (
                <ul className="op-keys" aria-label="Keys">
                  {integration.keys.map((line) => (
                    <KeyItem
                      key={line.id}
                      line={line}
                      called={view.called}
                      path={path}
                      stepUp={view.stepUp}
                    />
                  ))}
                </ul>
              )}
              {integration.keysCut === null ? null : (
                <p className="op-sub">{integration.keysCut}</p>
              )}
            </div>
          </section>
        </div>

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
                  <dd>
                    {selling.settled.amount} <small>USD</small>
                  </dd>
                </div>
                <div>
                  <dt>Orders made</dt>
                  <dd>{selling.orders}</dd>
                </div>
              </dl>
              <Sparkline days={selling.days} />
              <p className="op-sub">
                {selling.settled.count} settled {selling.settled.count === 1 ? "sale" : "sales"}, in
                USD per day. The dot is today so far.
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
                          ? " · its shop order is uncertain; the merchant recovers it from their Orders"
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

          <section className="op-panel" aria-labelledby="products-title">
            <div className="op-panel-head">
              <h2 id="products-title">Products</h2>
              <p>
                {selling.onSale} of {selling.published} on sale
              </p>
            </div>
            <div className="op-panel-body">
              {view.cards.rows.length === 0 ? (
                <p className="quiet">No product is published.</p>
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
                        {card.timing} · <span className="op-id">{card.code}</span>
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
          <p className="group-aside">From the journal</p>
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
        {view.history?.cut == null ? null : (
          <p className="cut">
            <span>{view.history.cut}</span>
            <Link to={journal}>All {view.history.total} in the journal</Link>
          </p>
        )}
      </section>
    </>
  );
}
