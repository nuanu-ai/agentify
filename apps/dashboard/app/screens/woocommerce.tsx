import { Button, Field } from "@agentify/ui";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import type {
  ConnectionView,
  NoKeysYet,
  RateView,
  Refusal,
  WooImportView,
  WooShopView,
} from "../../src/woo-views.js";
import type { Word as WordView } from "../../src/words.js";
import { type Chrome, useChrome } from "../answer.js";
import { Ident } from "../components/copy.js";
import { Frame } from "../components/frame.js";
import { GatePage } from "../components/gate-page.js";
import { Cell, Group, List, Row } from "../components/list.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Word } from "../components/word.js";
import styles from "./woocommerce.module.css";

/** Where the connector's rules are written in full, for what these panels say short. */
const GUIDE = "/docs/woocommerce";

const CONNECTED: WordView = { text: "Connected", tone: "ok" };

/** A refusal beside the control that was pressed, with each order it names to be copied. */
function Problem({ said, base }: Readonly<{ said: Refusal | null; base: string }>) {
  if (said === null) return null;
  if (said.orders.length === 0) return <p className="problem">{said.says}</p>;
  return (
    <div className={styles.refusal}>
      <p className="problem">{said.says}</p>
      <ul className={styles.orders} aria-label="The orders still waiting">
        {said.orders.map((order) => (
          <li key={order}>
            <Ident value={order} what="order ID" />
          </li>
        ))}
        {said.more === 0 ? null : (
          <li>
            and {said.more} more on <a href={`${base}/orders`}>Orders</a>
          </li>
        )}
      </ul>
    </div>
  );
}

const Exclamation = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16.5v.5" />
  </svg>
);

const Tick = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12 5 5 9-10" />
  </svg>
);

/** A panel that is a form: its heading, its sentence, and what is pressed. */
function FormPanel({
  action,
  title,
  attention = false,
  children,
}: Readonly<{
  action: string;
  title: string;
  attention?: boolean;
  children: (pending: boolean) => ReactNode;
}>) {
  return (
    <PostForm
      action={action}
      className={attention ? `${styles.panel} ${styles.attention}` : styles.panel}
    >
      {(pending) => (
        <>
          <h2>{title}</h2>
          {children(pending)}
        </>
      )}
    </PostForm>
  );
}

/** Only the wait has a next step of its own; a Connect that ran out is answered by the form it is in. */
function NoKeysYetNote({ said, base }: Readonly<{ said: NoKeysYet; base: string }>) {
  return (
    <div className={styles.note}>
      <Exclamation />
      <div>
        <b>{said.what}</b> {said.why}
        {said.waiting ? (
          <div>
            <a className="button button-secondary button-compact" href={`${base}/woocommerce`}>
              Check again
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WayBack({ leaving, base }: Readonly<{ leaving: Refusal | null; base: string }>) {
  return (
    <FormPanel
      action="/woocommerce/disconnect"
      title="You sell through a WooCommerce shop, and none is connected"
      attention
    >
      {(pending) => (
        <>
          <p className={styles.sub}>
            Nothing sells until one is connected. To sell through your own code instead, switch
            back: its cards come back with selling stopped until you resume it on Cards.
          </p>
          <Button variant="secondary" pending={pending}>
            Sell through your own code
          </Button>
          <Problem said={leaving} base={base} />
        </>
      )}
    </FormPanel>
  );
}

function ConnectPanel({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <FormPanel action="/woocommerce/connect" title="Connect your shop">
      {(pending) => (
        <>
          <p className={styles.sub}>
            Your browser goes to the shop next, and WooCommerce asks you to approve.
          </p>
          {view.noKeysYet === null ? null : <NoKeysYetNote said={view.noKeysYet} base={base} />}
          <Field
            label="Shop address"
            hint="The public https address at the root of the shop."
            name="shop_url"
            type="url"
            inputMode="url"
            placeholder="https://shop.example.com"
            defaultValue={view.typed}
            required
          />
          {view.connectSwitches ? (
            <div className={styles.note}>
              <Exclamation />
              <span>
                Connecting switches you to selling through the shop at once, before you approve: the
                cards your own code published go off sale, and your code gets no orders, until you
                disconnect. Orders your code is still working on have to finish first.
              </span>
            </div>
          ) : null}
          <Button pending={pending}>Connect</Button>
          <Problem said={view.problem} base={base} />
        </>
      )}
    </FormPanel>
  );
}

function WhatCanBeImported() {
  return (
    <section className={styles.panel}>
      <h2>What can be imported</h2>
      <p className={styles.sub}>Everything else stays in your shop untouched.</p>
      <ul className={styles.ticks}>
        <li>
          <Tick />
          <span>
            <b>Simple products</b>, published, without stock management, from a shop priced in US
            dollars or in another currency at a rate you set
          </span>
        </li>
        <li>
          <Tick />
          <span>
            <b>A download</b> with one protected file and unlimited downloads, handed to the agent
            once paid
          </span>
        </li>
        <li>
          <Tick />
          <span>
            <b>A parcel</b>: a physical product. The agent pays its price plus your cheapest
            shipping rate to the buyer and any tax your shop charges there, and your shop gets a
            paid order with the buyer's address
          </span>
        </li>
        <li>
          <Tick />
          <span>In the shop, permalinks are set to anything but Plain</span>
        </li>
      </ul>
      <p className={styles.sub}>
        Where WooCommerce calculates tax, your shop must round tax at the subtotal; a download then
        sells only if your prices are entered with tax, and a parcel at what your cart charges with
        tax. Tax from an outside service is not supported.
      </p>
      <a className={styles.more} href={GUIDE}>
        Connector guide
      </a>
    </section>
  );
}

function NotConnected({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <>
      <p className={styles.lead}>
        Import your shop's products as cards that agents can buy. You approve access in WooCommerce;
        Agentify never asks for your shop password.
      </p>
      {view.wayBack ? <WayBack leaving={view.leaving} base={base} /> : null}
      <div className={styles.cols}>
        <ConnectPanel view={view} base={base} />
        <WhatCanBeImported />
      </div>
    </>
  );
}

/**
 * The answer to a press of Import refused for what Settings sets, naming it
 * as Settings does and linking there.
 */
function BeforeImportingNote({
  connection,
  base,
}: Readonly<{ connection: ConnectionView; base: string }>) {
  const before = connection.beforeImporting;
  if (before === null) return null;
  return (
    <p className="problem" role="alert">
      Nothing was imported. Set {before.what} in <a href={`${base}/settings`}>Settings</a>, then
      import again.
    </p>
  );
}

/**
 * The rate of a shop priced in another currency: the merchant's own, and
 * Coinbase's open rate beside it as plain text, which catches a mistyped rate
 * and prices nothing. A rate far from it is asked for a second time.
 */
function RatePanel({ rate }: Readonly<{ rate: RateView }>) {
  const { current, reference } = rate;
  return (
    <FormPanel action="/woocommerce/rate" title="Exchange rate" attention={current === null}>
      {(pending) => (
        <>
          <p className={styles.sub}>
            Your shop sells in {rate.named}. Buyers pay in US dollars, at the rate you set: how many{" "}
            {rate.currency} one US dollar buys.
            {current === null ? " Nothing is published until you set one." : null}
          </p>
          {rate.saved === null ? null : <p className={styles.arrived}>{rate.saved}</p>}
          {current === null ? null : (
            <p className={current.far ? "problem" : styles.sub}>
              Your rate, {current.rate} {rate.currency} per US dollar, was entered at{" "}
              <Moment at={current.setAt} />
              {current.gap === null ? "." : `; it is ${current.gap} Coinbase's open rate.`}{" "}
              {current.sessionSignedInAt === null ? (
                "It was entered from a session signed in to this account; when that session signed in is not recorded."
              ) : (
                <>
                  It was entered from a session that signed in to this account at{" "}
                  <Moment at={current.sessionSignedInAt} />. A session copied from a browser of
                  yours shows that browser's own sign-in, so a moment you recognise does not prove
                  it was you.
                </>
              )}
            </p>
          )}
          {reference.kind === "read" ? (
            <p className={styles.sub}>
              Reference: {reference.rate} {rate.currency} per US dollar, open rate, source:
              Coinbase, read <Moment at={reference.readAt} />.
            </p>
          ) : reference.kind === "unlisted" ? (
            <p className="problem">
              Coinbase gives no rate for {rate.currency}, so no rate can be saved for this shop.
            </p>
          ) : (
            <p className={styles.sub}>
              Coinbase's rate could not be read just now, so a rate saved now is not compared with
              anything.
            </p>
          )}
          <input type="hidden" name="currency" value={rate.currency} autoComplete="off" />
          <Field
            label={`${rate.currency} per US dollar`}
            name="rate"
            inputMode="decimal"
            defaultValue={rate.typed === "" ? (current?.rate ?? "") : rate.typed}
            required
          />
          {rate.again === null ? null : (
            <>
              <p className="problem">{rate.again}</p>
              <Field label="The same rate, typed again" name="again" inputMode="decimal" required />
            </>
          )}
          <Button pending={pending}>Save rate</Button>
          {rate.problem === null ? null : <p className="problem">{rate.problem}</p>}
        </>
      )}
    </FormPanel>
  );
}

function ParcelRules({ base }: Readonly<{ base: string }>) {
  return (
    <section className={styles.panel}>
      <h2>Parcels</h2>
      <p className={styles.sub}>These describe what Agentify records about a parcel.</p>
      <ol className={styles.rules}>
        <li>
          <span>
            Ship within <b>seven days</b> of payment and mark the order <b>Completed</b> in
            WooCommerce. Not Completed by then, it shows on Orders as unfulfilled; Completed later,
            within thirty days of the order, still records shipment unless you have closed Agentify
            fulfillment.
          </span>
        </li>
        <li>
          <span>
            <b>Completed cannot be taken back</b>: it tells the buyer the parcel has shipped. With a
            WooCommerce fulfilment the buyer also gets the carrier and tracking; without one, your
            shipping method's name and no tracking number.
          </span>
        </li>
        <li>
          <span>
            An order you cancel or refund in WooCommerce has not shipped: it is unfulfilled when its
            seven days run out.
          </span>
        </li>
        <li>
          <span>
            If Orders shows an unfulfilled order before the seven days are up while your shop holds
            a paid order for it, <b>do not ship</b>: Agentify could not confirm that order. Close
            fulfillment on Orders instead, with an explanation to the buyer.
          </span>
        </li>
        <li>
          <span>
            Parcel cards are published only once your shop's site is set in{" "}
            <a href={`${base}/settings`}>Settings</a>: it is where a buyer asks about a parcel that
            did not arrive.
          </span>
        </li>
      </ol>
      <a className={styles.more} href={`${GUIDE}#parcels`}>
        All parcel rules
      </a>
    </section>
  );
}

/**
 * With a read-only grant the refusal is the answer to Connect again and is
 * drawn beside it; otherwise it is what the shop answered when an import read
 * it, which is about the connection, so it goes under the status.
 */
function Connected({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  return (
    <>
      <p className={styles.status}>
        <Word word={CONNECTED} />
        <span className={styles.shop}>{connection.shopUrl}</span>
        <span className={styles.since}>
          since <Moment at={connection.connectedAt} />
        </span>
      </p>
      {view.keysArrived ? (
        <p className={styles.arrived}>
          Your shop is connected: the keys came directly from its server.
        </p>
      ) : null}
      {connection.granted === null ? <Problem said={view.problem} base={base} /> : null}
      {connection.granted === null ? null : (
        <FormPanel
          action="/woocommerce/connect"
          title={`Your shop granted ${connection.granted} access, not read and write`}
          attention
        >
          {(pending) => (
            <>
              <p className={styles.sub}>
                Every purchase is refused before payment, because Agentify cannot create its order
                in your shop. Connect again and approve read and write access; you stay connected
                until the new keys arrive.
                {connection.offerSwitch
                  ? " Connecting also switches you to selling through the shop at once."
                  : null}
              </p>
              <input type="hidden" name="shop_url" value={connection.shopUrl} autoComplete="off" />
              <Button pending={pending}>Connect again</Button>
              <Problem said={view.problem} base={base} />
            </>
          )}
        </FormPanel>
      )}
      {connection.offerSwitch ? (
        <FormPanel action="/woocommerce/switch" title="You sell through your own code" attention>
          {(pending) => (
            <>
              <p className={styles.sub}>
                This shop's cards are off sale, and nothing can be imported, until you switch.
                Switching takes the cards your code published off sale, and your code gets no orders
                until you disconnect the shop.
              </p>
              <Button pending={pending}>Sell through this shop</Button>
              <Problem said={connection.switching} base={base} />
            </>
          )}
        </FormPanel>
      ) : null}
      <div className={styles.cols}>
        <div className={styles.stack}>
          {connection.rate === null ? null : <RatePanel rate={connection.rate} />}
          <FormPanel action="/woocommerce/import" title="Import products">
            {(pending) => (
              <>
                <p className={styles.sub}>
                  Reads up to {connection.productsAtMost.toLocaleString("en-US")} products and
                  publishes{" "}
                  <a href={`${GUIDE}#what-can-be-imported`}>the ones the connector supports</a>; the
                  rest stay in your shop. Running it again updates the same cards. A shop with more
                  than {connection.productsAtMost.toLocaleString("en-US")} products is refused
                  whole, not cut short.
                </p>
                <Button pending={pending}>Import products</Button>
                <BeforeImportingNote connection={connection} base={base} />
              </>
            )}
          </FormPanel>
          <section className={styles.panel}>
            <h2>When a product changes in the shop</h2>
            <p className={styles.sub}>
              A product deleted, sold out or no longer supported keeps its card, but its purchase is
              refused before payment. Pause the cards you no longer want agents to see on{" "}
              <a href={`${base}/cards`}>Cards</a>.
            </p>
          </section>
          <FormPanel action="/woocommerce/disconnect" title="Disconnect">
            {(pending) => (
              <>
                <p className={styles.sub}>
                  Deletes Agentify's copy of the shop's keys, which stay valid in WooCommerce until
                  you revoke them there, and switches you back to your own code: the shop's cards go
                  off sale, and the cards your code published come back with selling stopped. Orders
                  still waiting on the shop have to finish first. An unfulfilled parcel stays
                  unfulfilled: once the shop is disconnected, marking it Completed no longer records
                  shipment in Agentify.{" "}
                  <a href={`${GUIDE}#disconnecting`}>What disconnecting does</a>.
                </p>
                <Button variant="secondary" pending={pending}>
                  <span className={styles.leave}>Disconnect shop</span>
                </Button>
                <Problem said={view.leaving} base={base} />
              </>
            )}
          </FormPanel>
        </div>
        <ParcelRules base={base} />
      </div>
    </>
  );
}

export function WooShopScreen({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <div className={styles.page}>
      {view.connection === null ? (
        <NotConnected view={view} base={base} />
      ) : (
        <Connected connection={view.connection} view={view} base={base} />
      )}
    </div>
  );
}

/** The shop's own number for a product, which the merchant finds it by in their shop. */
const InTheShop = ({ id }: Readonly<{ id: string }>) => (
  <Cell at="ident">
    <span className={styles.quiet}>Product {id} in your shop</span>
  </Cell>
);

const ONE_COLUMN = "minmax(0, 1fr)";
const WITH_ACTION = "minmax(0, 1fr) auto";

export function WooImportScreen({ view, base }: Readonly<{ view: WooImportView; base: string }>) {
  const tally: readonly (readonly [number, string])[] = [
    [view.published.length, "published"],
    [view.refused.length, "to fix"],
    [view.unanswered.length, "without a verdict"],
    [view.notAttempted.length, "not attempted"],
    [view.skipped.length, "not imported"],
  ];
  return (
    <div className={styles.page}>
      {view.rateSaved === null ? null : <p className={styles.arrived}>{view.rateSaved}</p>}
      <p className={styles.read}>
        <span className={styles.shop}>{view.shopUrl}</span> ·{" "}
        {`${view.read} ${view.read === 1 ? "product" : "products"} read`}
      </p>
      <ul className={styles.tally} aria-label="What became of them">
        {tally
          .filter(([count, what]) => count > 0 || what === "published")
          .map(([count, what]) => (
            <li key={what}>
              <b>{count}</b> {what}
            </li>
          ))}
      </ul>
      {view.published.length === 0 ? null : (
        // Named for what publishing did and no more: its answer says nothing
        // about selling, and a card the merchant paused stays paused, so "on
        // sale" would be a guess.
        <Group
          title="Published"
          count={view.published.length}
          aside="A card you paused stays paused; whether each sells is on Cards."
        >
          <List label="Published" columns={WITH_ACTION}>
            {view.published.map((one) => (
              <Row key={one.id}>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
                </Cell>
                <Cell at="action">
                  <a href={`${base}/cards?${new URLSearchParams({ q: one.code })}`}>
                    Open in Cards
                  </a>
                </Cell>
              </Row>
            ))}
          </List>
        </Group>
      )}
      {view.refused.length === 0 ? null : (
        // Word for word: the merchant's next move is to change the named thing,
        // and a paraphrase would be a second description of a rule that has one.
        <Group
          title="To fix"
          count={view.refused.length}
          warn
          aside="Agentify's publishing rules, in their own words: change what they name, then import again."
        >
          <div className={styles.fixes}>
            <List label="To fix" columns={WITH_ACTION}>
              {view.refused.map((one) => (
                <Row key={one.id} needsYou>
                  <Cell at="main">
                    <Cell at="title">{one.title}</Cell>
                    <InTheShop id={one.id} />
                    <Cell at="note">
                      <ul className={styles.findings}>
                        {one.problems.map((problem, at) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: one card's findings never reorder
                          <li key={at}>{problem}</li>
                        ))}
                      </ul>
                    </Cell>
                  </Cell>
                  {one.fix === null ? null : (
                    <Cell at="action">
                      <a
                        className="button button-secondary button-compact"
                        href={`${base}${one.fix.to}`}
                      >
                        {one.fix.words}
                      </a>
                    </Cell>
                  )}
                </Row>
              ))}
            </List>
          </div>
          <p className={styles.after}>
            A length is counted with the markup removed, so your shop's editor shows a larger
            number.
          </p>
        </Group>
      )}
      {view.unanswered.length === 0 ? null : (
        // Nobody read these products, so no edit in the shop helps.
        <Group
          title="No verdict"
          count={view.unanswered.length}
          aside="Agentify gave no verdict on these, so nothing in your shop needs changing. Import again later; it does not double cards."
        >
          <List label="No verdict" columns={ONE_COLUMN}>
            {view.unanswered.map((one) => (
              <Row key={one.id}>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
                  <Cell at="note">
                    <span className={styles.left}>{one.failed}</span>
                  </Cell>
                </Cell>
              </Row>
            ))}
          </List>
        </Group>
      )}
      {view.notAttempted.length === 0 ? null : (
        <Group
          title="Not attempted"
          count={view.notAttempted.length}
          aside="The import stopped at the first product without a verdict, so these were not sent. Import again later."
        >
          <List label="Not attempted" columns={ONE_COLUMN}>
            {view.notAttempted.map((one) => (
              <Row key={one.id} off>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
                </Cell>
              </Row>
            ))}
          </List>
        </Group>
      )}
      {view.skipped.length === 0 ? null : (
        // Apart from the refused: those the publish door would not take, these
        // could not be read as a card at all, and the merchant's move differs.
        <Group
          title="Not imported"
          count={view.skipped.length}
          aside="left in your shop as they are"
        >
          <List label="Not imported" columns={ONE_COLUMN}>
            {view.skipped.map((one) => (
              <Row key={one.id} off>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
                  <Cell at="note">
                    <span className={styles.left}>{one.why}</span>
                  </Cell>
                </Cell>
              </Row>
            ))}
          </List>
        </Group>
      )}
      <div className={styles.ends}>
        <a className="button button-primary" href={`${base}/cards`}>
          Go to Cards
        </a>
        <a className="button button-secondary" href={`${base}/woocommerce`}>
          Back to WooCommerce
        </a>
      </div>
    </div>
  );
}

/**
 * The shop screen, or what an import did, in the dashboard's frame. A press
 * that was refused is answered with the shop screen, which says why beside the
 * control that was pressed.
 */
export function WooPage({ view }: Readonly<{ view: WooShopView | WooImportView | undefined }>) {
  const { base } = useChrome();
  if (view === undefined) {
    // Back or Forward inside the application to a press's address, where
    // React Router keeps no answer: the shop screen is where the forms are. A
    // read of the address from outside is sent there before any page is drawn.
    return <Navigate to="/woocommerce" replace />;
  }
  return view.screen === "shop" ? (
    <Frame tab="integrations" title="WooCommerce">
      <WooShopScreen view={view} base={base} />
    </Frame>
  ) : (
    <Frame
      tab="integrations"
      title="WooCommerce import"
      heading={view.finished ? "Import finished" : "Import stopped"}
    >
      <WooImportScreen view={view} base={base} />
    </Frame>
  );
}

/**
 * The session cookie is `SameSite=Lax`, so a signed-in browser coming back from
 * its shop is sent on into the dashboard before this is drawn. What arrives
 * here came back without a session (it ended meanwhile, or the shop was opened
 * in another browser), and a sign-in form here would read as a failed connect.
 *
 * So the page is for anybody and every word may be read by anybody: it says
 * what this address is for, not that a connection happened, names no account,
 * shop or key, and is the same whatever this dashboard holds. It asks for no
 * email and does not interpret the untrusted redirect query.
 */
export function WooReturnScreen({ chrome }: Readonly<{ chrome: Chrome }>) {
  return (
    <GatePage chrome={chrome} title="Back from your shop">
      <form className="gate-card" method="get" action={`${chrome.base}/woocommerce`}>
        <h1>Back from your shop</h1>
        <p>
          Continue to your dashboard to see whether access reached Agentify. If you chose not to
          connect, you can try again there.
        </p>
        <input type="hidden" name="from" value="shop" />
        <Button>Continue to your dashboard</Button>
      </form>
    </GatePage>
  );
}
