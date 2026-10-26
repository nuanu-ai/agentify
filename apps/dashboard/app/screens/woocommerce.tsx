import { Button, Field } from "@agentify/ui";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import type {
  ConnectionView,
  ImportHeld,
  NoKeysYet,
  RateView,
  Refusal,
  WooImportView,
  WooShopView,
} from "../../src/woo-views.js";
import { NO_SHOP } from "../../src/woo-words.js";
import type { Word as WordView } from "../../src/words.js";
import { type Chrome, useChrome } from "../answer.js";
import { Ident } from "../components/copy.js";
import { Frame } from "../components/frame.js";
import { GatePage } from "../components/gate-page.js";
import { Cell, Fact, Facts, Group, List, Row } from "../components/list.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Word } from "../components/word.js";
import styles from "./woocommerce.module.css";

/** Where the connector's rules are written in full; the screens link to it once. */
const GUIDE = "/docs/woocommerce";

const CONNECTED: WordView = { text: "Connected", tone: "ok" };

/** Every purchase is refused before payment, so the connection is not a success to show green. */
const NO_READ_WRITE: WordView = { text: "No Read/Write access", tone: "warn" };

/** The same words wherever a switch is about the products the merchant's own code published. */
const codeProducts = (count: number | null): string =>
  count === null
    ? "the products your code published"
    : count === 1
      ? "the product your code published"
      : `the ${count} products your code published`;

/** Said before a Connect: nothing changes for the code's products until the shop's keys arrive. */
const offSaleOnKeys = (count: number | null): string =>
  `${codeProducts(count)} ${count === 1 ? "goes" : "go"} off sale`;

const comeBack = (count: number | null): string => {
  const said = codeProducts(count);
  return `${said.charAt(0).toUpperCase()}${said.slice(1)} ${count === 1 ? "comes" : "come"} back paused.`;
};

/**
 * Why a press was refused, at the top of the panel it was made in, with each
 * order it names to be copied and the way to all of them on Orders.
 */
function Problem({ said, base }: Readonly<{ said: Refusal | null; base: string }>) {
  if (said === null) return null;
  if (said.orders.length === 0) {
    return (
      <>
        <p className="problem">{said.says}</p>
        {said.follow === "pause" ? (
          <p>
            If new purchases keep arriving, <a href={`${base}/products`}>pause all sales</a> first.
          </p>
        ) : said.follow === "products" ? (
          <p>
            Its products appear on <a href={`${base}/products`}>Products</a> as it publishes them.
          </p>
        ) : null}
      </>
    );
  }
  return (
    <div className={styles.refusal}>
      <p className="problem">{said.says}</p>
      <ul className={styles.orders} aria-label="The orders still open">
        {said.orders.map((order) => (
          <li key={order}>
            <Ident value={order} what="order ID" />
          </li>
        ))}
        {said.more === 0 ? null : <li>and {said.more} more</li>}
      </ul>
      <a href={`${base}/orders?show=open`}>See open orders</a>
    </div>
  );
}

/** A state that needs the merchant, said once at the top of the page in the notice's colours. */
function Notice({
  what,
  why,
  children,
}: Readonly<{ what: string; why: string; children?: ReactNode }>) {
  return (
    <div className={`callout ${styles.notice}`}>
      <div className="what">{what}</div>
      <p className="why">{why}</p>
      {children}
    </div>
  );
}

/** A panel's heading and its words, with what the last press in it came to under the heading. */
function PanelHead({
  title,
  said,
  children,
}: Readonly<{ title: string; said?: ReactNode; children?: ReactNode }>) {
  return (
    <div className="lede">
      <div>
        <h2>{title}</h2>
        {said}
        {children}
      </div>
    </div>
  );
}

function ConnectPanel({
  view,
  base,
  wide,
}: Readonly<{ view: WooShopView; base: string; wide: boolean }>) {
  return (
    <section className={wide ? "settings-panel settings-wide" : "settings-panel"}>
      <PanelHead title="Connect your shop" said={<Problem said={view.problem} base={base} />}>
        <p>
          You approve access in WooCommerce, so Agentify never sees your shop password.{" "}
          <a href={`${GUIDE}#what-can-be-imported`}>What can be imported</a>
        </p>
        {view.connectSwitches && view.codeProducts !== 0 ? (
          <p>
            When your shop sends its keys, {offSaleOnKeys(view.codeProducts)} until you disconnect
            the shop.
          </p>
        ) : null}
        {view.testMoney ? (
          <p role="note" aria-label="Test purchases">
            A test purchase here makes a paid order in the shop you connect, marked as paid in test
            USDC; if it is your real shop, do not ship for it.
          </p>
        ) : null}
      </PanelHead>
      <PostForm action="/woocommerce/connect" className={`issue ${styles.row}`}>
        {(pending) => (
          <>
            {/* Text rather than url: the browser's own check would refuse an
                address typed without its scheme before the refusal that names
                the address meant. */}
            <Field
              label="Shop address"
              name="shop_url"
              type="text"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://shop.example.com"
              defaultValue={view.typed}
              {...(view.addressProblem === null ? {} : { error: view.addressProblem })}
              required
            />
            <Button pending={pending}>Connect</Button>
          </>
        )}
      </PostForm>
    </section>
  );
}

/** The way back to the merchant's own code, beside Connect and never above it. */
function WayBackPanel({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <section className="settings-panel">
      <PanelHead
        title="Sell through your own code"
        said={<Problem said={view.leaving} base={base} />}
      >
        <p>
          {view.codeProducts === 0
            ? "Go back to publishing products from your own code."
            : comeBack(view.codeProducts)}
        </p>
      </PanelHead>
      <PostForm action="/woocommerce/disconnect" className="issue">
        {(pending) => (
          <>
            <input type="hidden" name="shop" value={NO_SHOP} autoComplete="off" />
            <Button variant="secondary" pending={pending}>
              Use my own code
            </Button>
          </>
        )}
      </PostForm>
    </section>
  );
}

function NoKeysNotice({ said, base }: Readonly<{ said: NoKeysYet; base: string }>) {
  return (
    <Notice what={said.what} why={said.why}>
      {said.waiting ? (
        <a className="button button-secondary button-compact" href={`${base}/woocommerce`}>
          Check again
        </a>
      ) : null}
    </Notice>
  );
}

function NotConnected({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <>
      {view.noKeysYet !== null ? (
        <NoKeysNotice said={view.noKeysYet} base={base} />
      ) : view.wayBack ? (
        <Notice
          what="No shop is connected, so nothing sells"
          why="Connect your shop, or go back to selling through your own code."
        />
      ) : null}
      <div className="settings-grid">
        <ConnectPanel view={view} base={base} wide={!view.wayBack} />
        {view.wayBack ? <WayBackPanel view={view} base={base} /> : null}
      </div>
    </>
  );
}

/**
 * The connection's state, and beside it the small action that ends it. One
 * press does not disconnect: the first opens what disconnecting does, and the
 * button there is the second. A refusal opens it again where it was asked.
 */
function Status({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  return (
    <div className={styles.status}>
      <p className={styles.state}>
        <Word word={connection.readOnly ? NO_READ_WRITE : CONNECTED} />
        <span className={styles.shop}>{connection.shop}</span>
        <span className={styles.since}>
          since <Moment at={connection.connectedAt} />
        </span>
      </p>
      <details className={styles.disconnect} open={view.leaving !== null}>
        <summary>
          <span className={styles.closed}>Disconnect</span>
          <span className={styles.opened}>Cancel</span>
        </summary>
        <div className={styles.confirm}>
          <Problem said={view.leaving} base={base} />
          <p>
            Disconnect {connection.shop}?{" "}
            {connection.onCode
              ? "Agentify forgets its keys; its products are already off sale."
              : `Its products go off sale.${view.codeProducts === 0 ? "" : ` ${comeBack(view.codeProducts)}`} A late parcel marked Completed after that no longer counts as shipped.`}
          </p>
          <PostForm action="/woocommerce/disconnect" className={styles.confirmPress}>
            {(pending) => (
              <>
                <input type="hidden" name="shop" value={connection.shopUrl} autoComplete="off" />
                <Button variant="secondary" pending={pending}>
                  <span className={styles.leave}>Disconnect shop</span>
                </Button>
              </>
            )}
          </PostForm>
        </div>
      </details>
    </div>
  );
}

function ReadOnlyPanel({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  return (
    <section className="settings-panel">
      <PanelHead
        title="Approve read and write access"
        said={<Problem said={view.problem} base={base} />}
      >
        <p>
          Your shop didn't grant Read/Write access, so Agentify can't create orders there and agents
          can't buy. Connect again and approve Read/Write.
          {connection.onCode && view.codeProducts !== 0
            ? ` When the new keys arrive, ${offSaleOnKeys(view.codeProducts)}.`
            : null}
        </p>
      </PanelHead>
      <PostForm action="/woocommerce/connect" className="issue">
        {(pending) => (
          <>
            <input type="hidden" name="shop_url" value={connection.shopUrl} autoComplete="off" />
            <Button pending={pending}>Connect again</Button>
          </>
        )}
      </PostForm>
    </section>
  );
}

function SwitchPanel({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  return (
    <section className="settings-panel settings-wide">
      <PanelHead
        title="Sell through this shop"
        said={<Problem said={connection.switching} base={base} />}
      >
        <p>
          This shop's products are off sale while you sell through your own code.
          {view.codeProducts === 0
            ? null
            : ` Switching takes ${codeProducts(view.codeProducts)} off sale until you disconnect the shop.`}
        </p>
      </PanelHead>
      <PostForm action="/woocommerce/switch" className="issue">
        {(pending) => <Button pending={pending}>Sell through this shop</Button>}
      </PostForm>
    </section>
  );
}

/** Why Import is held, in a line under it, with the page that puts it right. */
function HeldLine({ held, base }: Readonly<{ held: ImportHeld; base: string }>) {
  switch (held.kind) {
    case "settings":
      return (
        <p className="quiet">
          Set your {held.what} in <a href={`${base}/settings`}>Settings</a> first.
        </p>
      );
    case "rate":
      return <p className="quiet">Set the exchange rate for {held.currency} first.</p>;
    case "unlisted":
      return (
        <p className="quiet">
          A shop priced in {held.currency} can't sell through Agentify, because Coinbase gives no
          rate for it.
        </p>
      );
  }
}

function ImportPanel({
  connection,
  keysArrived,
  wide,
  base,
}: Readonly<{ connection: ConnectionView; keysArrived: boolean; wide: boolean; base: string }>) {
  return (
    <section className={wide ? "settings-panel settings-wide" : "settings-panel"}>
      <PanelHead title="Import products" said={<Problem said={connection.importing} base={base} />}>
        <p>
          {keysArrived
            ? "Your shop is connected. Import your products to start selling."
            : "Imports every product the connector supports. Run it again after you change products in your shop."}{" "}
          <a href={`${GUIDE}#what-can-be-imported`}>What can be imported</a>
        </p>
      </PanelHead>
      <PostForm action="/woocommerce/import" className="issue">
        {(pending) => (
          <>
            <Button pending={pending} disabled={connection.held !== null}>
              Import products
            </Button>
            {connection.held === null ? null : <HeldLine held={connection.held} base={base} />}
          </>
        )}
      </PostForm>
    </section>
  );
}

/**
 * The rate of a shop priced in another currency: the merchant's own, and
 * Coinbase's open rate beside it, which catches a mistyped rate and prices
 * nothing. A rate far from it is asked for a second time.
 */
function RatePanel({ rate }: Readonly<{ rate: RateView }>) {
  const { current, reference } = rate;
  return (
    <section className="settings-panel">
      <PanelHead
        title="Exchange rate"
        said={
          <>
            {rate.saved === null ? null : <p className={styles.saved}>{rate.saved}</p>}
            {rate.refused === null ? null : <p className="problem">{rate.refused}</p>}
            {reference.kind === "unlisted" ? (
              <p className="problem">
                Coinbase gives no rate for {rate.currency}, so no rate can be saved for this shop.
              </p>
            ) : null}
          </>
        }
      >
        <p>
          Your shop sells in {rate.named}. Agents pay in US dollars at your rate.
          {current === null ? " Nothing is published until you set it." : null}
        </p>
      </PanelHead>
      {current === null && reference.kind !== "read" ? null : (
        <div className={styles.facts}>
          <Facts>
            {current === null ? null : (
              <>
                <Fact label="Your rate">
                  <span className={current.far ? styles.far : undefined}>
                    {current.rate} {rate.currency} per US dollar
                    {current.gap === null ? null : `, ${current.gap} Coinbase's`}
                  </span>
                </Fact>
                <Fact label="Saved">
                  <Moment at={current.setAt} />
                  {current.sessionSignedInAt === null ? (
                    ". When its session signed in isn't recorded."
                  ) : (
                    <>
                      , from a session that signed in <Moment at={current.sessionSignedInAt} />.
                      That time doesn't prove who saved it.
                    </>
                  )}
                </Fact>
              </>
            )}
            {reference.kind === "read" ? (
              <Fact label="Coinbase">
                {reference.rate} {rate.currency} per US dollar, read{" "}
                <Moment at={reference.readAt} />
              </Fact>
            ) : reference.kind === "unread" ? (
              <Fact label="Coinbase">
                Couldn't be read just now, so a rate saved now isn't compared with anything.
              </Fact>
            ) : null}
          </Facts>
        </div>
      )}
      <PostForm
        action="/woocommerce/rate"
        className={rate.again === null ? `issue ${styles.row}` : styles.again}
      >
        {(pending) => (
          <>
            <input type="hidden" name="currency" value={rate.currency} autoComplete="off" />
            <Field
              label={`${rate.currency} per US dollar`}
              name="rate"
              inputMode="decimal"
              defaultValue={rate.typed === "" ? (current?.raw ?? "") : rate.typed}
              {...(rate.problem === null ? {} : { error: rate.problem })}
              required
            />
            {rate.again === null ? null : (
              <>
                <p className={styles.check}>{rate.again}</p>
                <Field label="Type the rate again" name="again" inputMode="decimal" required />
              </>
            )}
            <Button pending={pending}>Save rate</Button>
          </>
        )}
      </PostForm>
    </section>
  );
}

function Connected({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  const { rate } = connection;
  const rateFirst = rate !== null && rate.current === null;
  // Selling through the code, nothing can be imported; the rate is the
  // shop's setting all the same, kept for when the merchant switches.
  const panels: ReactNode[] = connection.onCode
    ? [
        <SwitchPanel key="switch" connection={connection} view={view} base={base} />,
        ...(rate === null ? [] : [<RatePanel key="rate" rate={rate} />]),
      ]
    : [
        ...(rateFirst ? [<RatePanel key="rate" rate={rate} />] : []),
        <ImportPanel
          key="import"
          connection={connection}
          keysArrived={view.keysArrived}
          wide={rate === null && !connection.readOnly}
          base={base}
        />,
        ...(rate !== null && !rateFirst ? [<RatePanel key="rate" rate={rate} />] : []),
      ];
  return (
    <>
      <Status connection={connection} view={view} base={base} />
      <div className="settings-grid">
        {connection.readOnly ? (
          <ReadOnlyPanel connection={connection} view={view} base={base} />
        ) : null}
        {panels}
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

/**
 * Groups in the order of what the merchant does: put right, import again,
 * read, and last the products that went through, folded, since a shop of two
 * thousand would otherwise push everything to do below them.
 */
export function WooImportScreen({ view, base }: Readonly<{ view: WooImportView; base: string }>) {
  return (
    <div className={styles.page}>
      {view.rateSaved === null ? null : <p className={styles.done}>{view.rateSaved}</p>}
      <p className={styles.read}>
        {view.shop} · {`${view.read} ${view.read === 1 ? "product" : "products"} read`}
      </p>
      {view.toFix.length === 0 ? null : (
        // Agentify's findings word for word: the merchant's next move is to
        // change the named thing, and a paraphrase would be a second
        // description of a rule that has one.
        <Group
          title="To fix"
          count={view.toFix.length}
          warn
          aside="Change these in your shop, then import again."
        >
          <div className={styles.fixes}>
            <List label="To fix" columns={WITH_ACTION}>
              {view.toFix.map((one) => (
                <Row key={one.id} needsYou>
                  <Cell at="main">
                    <Cell at="title">{one.title}</Cell>
                    <InTheShop id={one.id} />
                    <Cell at="note">
                      <ul className={styles.findings}>
                        {one.says.map((said, at) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: one product's findings never reorder
                          <li key={at}>{said}</li>
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
          {view.tooLong ? (
            <p className={styles.after}>
              A length is counted without formatting, so your shop's editor shows a larger number.
            </p>
          ) : null}
        </Group>
      )}
      {view.unanswered.length === 0 ? null : (
        // Nobody read these products, so no edit in the shop helps.
        <Group
          title="No verdict"
          count={view.unanswered.length}
          aside="Agentify didn't answer, so we don't know if these were published. Import again: it won't create duplicates."
        >
          <List label="No verdict" columns={ONE_COLUMN}>
            {view.unanswered.map((one) => (
              <Row key={one.id}>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
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
          aside="The import stopped before these. Import again."
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
      {view.unsupported.length === 0 ? null : (
        <Group
          title="Not supported"
          count={view.unsupported.length}
          aside="The connector doesn't import these."
        >
          <List label="Not supported" columns={ONE_COLUMN}>
            {view.unsupported.map((one) => (
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
      {view.published.length === 0 ? null : (
        // Named for what publishing did and no more: its answer says nothing
        // about selling, and a product the merchant paused stays paused, so
        // "on sale" would be a guess.
        <Group title="Published" count={view.published.length} aside="Paused products stay paused.">
          <details className={styles.fold}>
            <summary>Show the published products</summary>
            <List label="Published" columns={ONE_COLUMN}>
              {view.published.map((one) => (
                <Row key={one.id}>
                  <Cell at="main">
                    <Cell at="title">
                      <a href={`${base}/products?${new URLSearchParams({ q: one.code })}`}>
                        {one.title}
                      </a>
                    </Cell>
                    <InTheShop id={one.id} />
                  </Cell>
                </Row>
              ))}
            </List>
          </details>
        </Group>
      )}
      <div className={styles.ends}>
        <a className="button button-secondary" href={`${base}/woocommerce`}>
          Back to WooCommerce page
        </a>
      </div>
    </div>
  );
}

/**
 * What the import result leads to next, drawn at the end of the page's bar:
 * Import again where something was left to it, Products where products went
 * through.
 */
function AfterImport({ view, base }: Readonly<{ view: WooImportView; base: string }>) {
  if (view.finished && view.published.length > 0) {
    return (
      <a className="button button-primary" href={`${base}/products`}>
        Go to Products
      </a>
    );
  }
  return (
    <PostForm action="/woocommerce/import">
      {(pending) => <Button pending={pending}>Import again</Button>}
    </PostForm>
  );
}

/**
 * The shop screen, or what an import did, in the dashboard's frame. A press
 * that was refused is answered with the shop screen, which says why in the
 * panel of the control that was pressed.
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
      action={<AfterImport view={view} base={base} />}
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
      <form className="message-panel" method="get" action={`${chrome.base}/woocommerce`}>
        <h1>Back from your shop</h1>
        <p>Open your dashboard to see if your shop connected.</p>
        <input type="hidden" name="from" value="shop" />
        <Button>Open dashboard</Button>
      </form>
    </GatePage>
  );
}
