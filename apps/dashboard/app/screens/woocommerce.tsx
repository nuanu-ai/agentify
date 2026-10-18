import { Button, Field } from "@agentify/ui";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import type { ConnectionView, NoKeysYet, WooImportView, WooShopView } from "../../src/woo-views.js";
import type { Word as WordView } from "../../src/words.js";
import { type Chrome, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { GatePage } from "../components/gate-page.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Word } from "../components/word.js";
import styles from "./woocommerce.module.css";

/** Where the connector's rules are written in full, for what these panels say short. */
const GUIDE = "/docs/woocommerce";

const CONNECTED: WordView = { text: "Connected", tone: "ok" };

const Problem = ({ said }: Readonly<{ said: string | null }>) =>
  said === null ? null : <p className="problem">{said}</p>;

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

function WayBack({ leaving }: Readonly<{ leaving: string | null }>) {
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
          <Problem said={leaving} />
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
          <Problem said={view.problem} />
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
            <b>Simple products</b> priced in USD, published, without stock management
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
            shipping rate, and your shop gets a paid order with the buyer's address
          </span>
        </li>
        <li>
          <Tick />
          <span>
            In the shop, <b>tax calculation is off</b> and permalinks are set to anything but Plain
          </span>
        </li>
      </ul>
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
      {view.wayBack ? <WayBack leaving={view.leaving} /> : null}
      <div className={styles.cols}>
        <ConnectPanel view={view} base={base} />
        <WhatCanBeImported />
      </div>
    </>
  );
}

/**
 * Names the setting as Settings does and links there; only the answer to a
 * refused press is an alert.
 */
function BeforeImportingNote({
  connection,
  base,
}: Readonly<{ connection: ConnectionView; base: string }>) {
  const before = connection.beforeImporting;
  if (before === null) return null;
  const settings = <a href={`${base}/settings`}>Settings</a>;
  return before.refused ? (
    <p className="problem" role="alert">
      Nothing was imported. Set {before.what} in {settings}, then import again.
    </p>
  ) : (
    <p className="problem">
      Import publishes nothing until you set {before.what} in {settings}.
    </p>
  );
}

function ParcelRules({ base }: Readonly<{ base: string }>) {
  return (
    <section className={styles.panel}>
      <h2>Parcels</h2>
      <p className={styles.sub}>These decide whether you keep the money for a parcel.</p>
      <ol className={styles.rules}>
        <li>
          <span>
            Ship within <b>seven days</b> of payment and mark the order <b>Completed</b> in
            WooCommerce. Not Completed by then, it shows on Orders as a refund you owe; Completed
            later, within thirty days of the order, still clears it unless a refund is already
            recorded.
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
            An order you cancel or refund in WooCommerce has not shipped: it becomes a refund you
            owe when its seven days run out.
          </span>
        </li>
        <li>
          <span>
            If Orders shows a refund owed before the seven days are up while your shop holds a paid
            order for it, <b>do not ship</b>: Agentify could not confirm it, and you owe the buyer a
            refund instead.
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
 * The refusal under the status is drawn there rather than on a form because
 * it is about something different: what the shop answered when we read it,
 * not what was just pressed.
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
      <Problem said={view.problem} />
      {connection.granted === null ? null : (
        <section className={`${styles.panel} ${styles.attention}`}>
          <h2>Your shop granted {connection.granted} access, not read and write</h2>
          <p className={styles.sub}>
            Every purchase is refused before payment, because Agentify cannot create its order in
            your shop. Connect again and approve read and write access.
          </p>
        </section>
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
              <Problem said={connection.switching} />
            </>
          )}
        </FormPanel>
      ) : null}
      <div className={styles.cols}>
        <div className={styles.stack}>
          <FormPanel action="/woocommerce/import" title="Import products">
            {(pending) => (
              <>
                <p className={styles.sub}>
                  Reads up to {connection.productsAtMost} products and publishes{" "}
                  <a href={`${GUIDE}#what-can-be-imported`}>the ones the connector supports</a>; the
                  rest stay in your shop. Running it again updates the same cards. A shop with more
                  than {connection.productsAtMost} products is refused whole, not cut short.
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
                  Removes the shop's keys and switches you back to your own code: the shop's cards
                  go off sale, and the cards your code published come back with selling stopped.
                  Orders still waiting on the shop have to finish first. A parcel already owed a
                  refund stays owed: once the shop is disconnected, marking it Completed no longer
                  clears the debt. <a href={`${GUIDE}#disconnecting`}>What disconnecting does</a>.
                </p>
                <Button variant="secondary" pending={pending}>
                  <span className={styles.leave}>Disconnect shop</span>
                </Button>
                <Problem said={view.leaving} />
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

const Block = ({ heading, children }: Readonly<{ heading: string; children: ReactNode }>) => (
  <div className="lede">
    <div>
      <h2>{heading}</h2>
      {children}
    </div>
  </div>
);

export function WooImportScreen({ view, base }: Readonly<{ view: WooImportView; base: string }>) {
  return (
    <>
      <div className="lede">
        <div>
          <p>{view.summary}</p>
          <p className="quiet">
            <a href={`${base}/cards`}>Your cards</a> ·{" "}
            <a href={`${base}/woocommerce`}>Back to the shop</a>
          </p>
        </div>
      </div>
      {view.published.length === 0 ? null : (
        // Named for what publishing did and no more: its answer says nothing
        // about selling, and a card the merchant paused stays paused, so "on
        // sale" would be a guess.
        <Block heading="Published">
          <p className="quiet">
            Each is one of your cards. Whether it can be bought is on your cards screen. A card you
            paused stays paused through an import, and while all selling is stopped no card takes an
            order.
          </p>
          <ul>
            {view.published.map((one) => (
              <li key={one.id}>
                {one.title}{" "}
                <span className="quiet">
                  — product {one.id} in your shop, card {one.published}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {view.refused.length === 0 ? null : (
        // Word for word: the merchant's next move is to change the named thing
        // in their shop, and a paraphrase would be a second description of a
        // rule that has one.
        <Block heading="Refused">
          <p className="quiet">
            These are our own publishing rules, and the sentences under each product are the ones
            the publish door gave. Change what they name in your shop and import again.
          </p>
          <p className="quiet">
            The count is of your description with markup removed, so your shop's editor shows a
            larger number.
          </p>
          <ul>
            {view.refused.map((one) => (
              <li key={one.id}>
                {one.title} <span className="quiet">— product {one.id}</span>
                <ul>
                  {one.problems.map((problem, at) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: one card's findings never reorder
                    <li key={at}>{problem}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {view.unanswered.length === 0 ? null : (
        // Nobody read these products, so no edit in the shop helps. "The
        // gateway" means the WooCommerce payment plugin to a WooCommerce
        // merchant, so the paragraph defines the word before the lines use it.
        <Block heading="No verdict">
          <p className="quiet">
            Nothing here is a finding about the product, and nothing in your shop needs changing:
            the part of Agentify that keeps your cards — the lines below call it the gateway — did
            not answer when this product was sent to it, or answered with something other than its
            verdict. Import again later; importing again does not double cards.
          </p>
          <ul>
            {view.unanswered.map((one) => (
              <li key={one.id}>
                {one.title} <span className="quiet">— product {one.id}</span>
                <ul>
                  <li>{one.failed}</li>
                </ul>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {view.notAttempted.length === 0 ? null : (
        <Block heading="Not attempted">
          <p className="quiet">
            Import stopped after the first product got no verdict, so these products were not sent
            to Agentify. Import again later.
          </p>
          <ul>
            {view.notAttempted.map((one) => (
              <li key={one.id}>
                {one.title} <span className="quiet">— product {one.id}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}
      {view.skipped.length === 0 ? null : (
        // Apart from the refused: those the gateway would not take, these
        // could not be read as a card at all, and the merchant's move differs.
        <Block heading="Left in the shop">
          <p className="quiet">
            Nothing was published for these, and nothing about them was changed in your shop.
          </p>
          <ul>
            {view.skipped.map((one) => (
              <li key={one.id}>
                {one.title} <span className="quiet">— product {one.id}</span>
                <br />
                {one.why}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </>
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
    <Frame tab="integrations" title="WooCommerce" frame={view.frame}>
      <WooShopScreen view={view} base={base} />
    </Frame>
  ) : (
    <Frame
      tab="integrations"
      title="WooCommerce import"
      heading={`What came over from ${view.shopUrl}`}
      frame={view.frame}
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
