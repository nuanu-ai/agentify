import { Button } from "@agentify/ui";
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import type { ConnectionView, NoKeysYet, WooImportView, WooShopView } from "../../src/woo-views.js";
import { type Chrome, useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";
import { GatePage } from "../components/gate-page.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";

/**
 * Said once, here, on the page with Connect and Import, which is the only
 * place the connector is described; the integrations block links here.
 */
function WhatConnectingDoes() {
  return (
    <div className="lede">
      <div>
        <p>
          The WooCommerce connector works in test mode only for now. It imports published simple
          products priced in USD, with no stock management, from a shop whose tax calculation is
          turned off, in two narrow configurations. A virtual download with one protected file and
          unlimited downloads is handed to the agent once it is paid for. A physical product,
          neither virtual nor downloadable, is sold as a parcel: the agent pays its price plus your
          shop's own cheapest shipping rate to the buyer's place, and your shop gets a paid order
          carrying the buyer's shipping address.
        </p>
        <p className="quiet">
          Connecting gives Agentify access to your shop, and importing publishes supported products
          as cards. You approve access in WooCommerce; Agentify never asks for your shop password.
        </p>
        <p className="quiet">
          You sell through your shop or through your own code, one at a time. While you sell through
          the shop, the cards your code published are off sale and your code receives no orders;
          disconnecting the shop here brings them back.
        </p>
      </div>
    </div>
  );
}

const Problem = ({ said }: Readonly<{ said: string | null }>) =>
  said === null ? null : <p className="problem">{said}</p>;

/** Only the wait has a next step of its own; a Connect that ran out is answered by the form below it. */
function NoKeysYetNote({ said, base }: Readonly<{ said: NoKeysYet; base: string }>) {
  return (
    <div className="callout">
      <div className="what">{said.what}</div>
      <p className="why">{said.why}</p>
      {said.waiting ? (
        <div className="connect-actions">
          <a className="button button-secondary" href={`${base}/woocommerce`}>
            Check again
          </a>
        </div>
      ) : null}
    </div>
  );
}

function WayBack({ leaving }: Readonly<{ leaving: string | null }>) {
  return (
    <PostForm action="/woocommerce/disconnect" className="issue">
      {(pending) => (
        <>
          <div>
            <label>You sell through a WooCommerce shop, and none is connected</label>
            <p className="quiet">
              Nothing sells until a shop is connected. To sell through your own code instead, switch
              back: the cards your code published come back, with selling stopped until you start it
              again on Cards.
            </p>
            <Problem said={leaving} />
          </div>
          <Button variant="secondary" pending={pending}>
            Sell through your own code
          </Button>
        </>
      )}
    </PostForm>
  );
}

function ConnectForm({ view }: Readonly<{ view: WooShopView }>) {
  return (
    <>
      <div className="lede">
        <div>
          <h2>Connect your shop</h2>
          <p>
            Type the address you open your own shop at. Your browser goes there next, so that
            WooCommerce can ask you to approve.
          </p>
          {view.connectSwitches ? (
            <p className="quiet">
              Pressing Connect switches you to selling through the shop at once, before you approve:
              the cards your code published go off sale and your code receives no orders. Orders
              your code is still working on have to finish first.
            </p>
          ) : null}
          <p className="quiet">
            Use the public https address at the root of the shop. WooCommerce permalinks must be set
            to anything other than Plain.
          </p>
        </div>
      </div>
      <PostForm action="/woocommerce/connect" className="issue">
        {(pending) => (
          <>
            <div>
              <label htmlFor="shop_url">The address of your shop</label>
              <input
                id="shop_url"
                name="shop_url"
                type="url"
                inputMode="url"
                placeholder="https://shop.example.com"
                defaultValue={view.typed}
                required
              />
            </div>
            <Button pending={pending}>Connect</Button>
            <Problem said={view.problem} />
          </>
        )}
      </PostForm>
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

/**
 * The refusal is drawn here as well as on the form because it is about
 * something different: what the shop answered when we read it, not what was
 * just typed.
 */
function Connection({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  return (
    <>
      <div className="lede">
        <div>
          <h2>Your shop</h2>
          <p>
            {connection.shopUrl}, connected <Moment at={connection.connectedAt} />.
          </p>
          <Problem said={view.problem} />
          {connection.granted === null ? null : (
            <p className="problem">
              Your shop granted {connection.granted} access rather than read and write. A fresh
              purchase is unavailable before payment because this connection cannot create its
              WooCommerce order. Connect again and approve read and write access.
            </p>
          )}
        </div>
      </div>
      {connection.offerSwitch ? (
        <PostForm action="/woocommerce/switch" className="issue">
          {(pending) => (
            <>
              <div>
                <label>You sell through your own code</label>
                <p className="quiet">
                  This shop is connected, but its cards are off sale and nothing can be imported
                  while you sell through your own code. Selling through the shop takes the cards
                  your code published off sale, and your code receives no orders until you
                  disconnect the shop here.
                </p>
                <Problem said={connection.switching} />
              </div>
              <Button pending={pending}>Sell through this shop</Button>
            </>
          )}
        </PostForm>
      ) : null}
      {connection.stopped ? (
        <p className="quiet">
          Selling is stopped, so nothing imported sells until you start it again on{" "}
          <a href={`${base}/cards`}>Cards</a>.
        </p>
      ) : null}
      <PostForm action="/woocommerce/import" className="issue">
        {(pending) => (
          <>
            <div>
              <label>Import the catalog</label>
              <p className="quiet">
                Reads up to {connection.productsAtMost} products and publishes only the product
                configuration currently supported by this connector, described above. Other products
                stay in your shop. If the shop has more than {connection.productsAtMost} products,
                the whole import is refused. Running it again updates the same cards.
              </p>
              <p className="quiet">
                If a product is later deleted from the shop, runs out, or stops being supported, its
                card stays listed, but the price check refuses the purchase before payment. Pause
                cards you no longer want agents to see.
              </p>
              <p className="quiet">
                Every parcel is published with seven days to ship. That number is Agentify's, not
                yours: WooCommerce has no field for it. A parcel's order that has not shipped seven
                days after payment reads as a refund owed. A parcel's card is published only once
                your shop's site is set in <a href={`${base}/settings`}>Settings</a>, because the
                site is where a buyer asks about a parcel that did not arrive.
              </p>
              <p className="quiet">
                Marking a parcel's order Completed in WooCommerce, in the shop it was sold from and
                within thirty days of it being placed, tells the buyer it has shipped, and that
                cannot be taken back. If the order has a fulfilled WooCommerce fulfilment, the buyer
                gets its carrier and tracking; otherwise the buyer is told your shipping method's
                name as the carrier, with no tracking number. An order not marked Completed within
                its seven days reads as a refund owed on your Orders screen, and marking it
                Completed later, within the thirty days, still clears that debt unless a refund has
                already been recorded. An order you cancel or refund in WooCommerce has not shipped,
                and becomes a refund owed when its seven days run out. If a parcel's order reads as
                a refund owed before its seven days are up while your shop holds a paid order for
                it, do not ship that order: Agentify could not confirm it, and you owe the buyer a
                refund instead.
              </p>
              <BeforeImportingNote connection={connection} base={base} />
            </div>
            <Button pending={pending}>Import the catalog</Button>
          </>
        )}
      </PostForm>
      <PostForm action="/woocommerce/disconnect" className="issue">
        {(pending) => (
          <>
            <div>
              <label>Disconnect</label>
              <p className="quiet">
                Deletes the keys your shop gave us and switches you back to selling through your own
                code: the shop's cards go off sale, and the cards your code published come back,
                with selling stopped until you start it again on Cards. Orders still waiting on the
                shop have to finish first, a parcel until it is marked Completed in WooCommerce. A
                parcel already owed a refund is no longer followed once the shop is disconnected, so
                marking it Completed after that does not clear the debt. To revoke the keys in the
                shop too, open WooCommerce → Settings → Advanced → REST API.
              </p>
              <Problem said={view.leaving} />
            </div>
            <Button variant="secondary" pending={pending}>
              Forget this shop
            </Button>
          </>
        )}
      </PostForm>
    </>
  );
}

export function WooShopScreen({ view, base }: Readonly<{ view: WooShopView; base: string }>) {
  return (
    <div className="integration-shell">
      <WhatConnectingDoes />
      {view.keysArrived ? (
        <div className="callout done">
          <div className="what">
            Your shop is connected: the keys came directly from its server.
          </div>
        </div>
      ) : null}
      {view.connection === null ? (
        <>
          {view.wayBack ? <WayBack leaving={view.leaving} /> : null}
          {view.noKeysYet === null ? null : <NoKeysYetNote said={view.noKeysYet} base={base} />}
          <ConnectForm view={view} />
        </>
      ) : (
        <Connection connection={view.connection} view={view} base={base} />
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
