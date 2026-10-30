import { Button, Field } from "@agentify/ui";
import { withUnit } from "@agentify/ui/units";
import type { ReactNode } from "react";
import type { ConnectionView, ImportHeld, RateView, WooShopView } from "../../src/woo-views.js";
import type { Word as WordView } from "../../src/words.js";
import { Fact, Facts } from "../components/list.js";
import { Moment } from "../components/moment.js";
import { Word } from "../components/word.js";
import { ShopForm } from "./shop-context.js";
import { codeProducts, comeBack, GUIDE, offSaleOnKeys, PanelHead, Problem } from "./woo-panels.js";
import styles from "./woocommerce.module.css";

const CONNECTED: WordView = { text: "Connected", tone: "ok" };

/** Every purchase is refused before payment, so the connection is not a success to show green. */
const NO_READ_WRITE: WordView = { text: "No Read/Write access", tone: "warn" };

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
        <Word word={connection.access !== "read_write" ? NO_READ_WRITE : CONNECTED} />
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
              ? "Agentify disconnects it; its products are already off sale."
              : `Its products go off sale.${view.codeProducts === 0 ? "" : ` ${comeBack(view.codeProducts)}`} A late parcel marked Completed after that no longer counts as shipped.`}
          </p>
          <ShopForm action="/woocommerce/disconnect" className={styles.confirmPress}>
            {(pending) => (
              <>
                <input type="hidden" name="shop" value={connection.shopUrl} autoComplete="off" />
                <Button variant="secondary" pending={pending}>
                  <span className={styles.leave}>Disconnect shop</span>
                </Button>
              </>
            )}
          </ShopForm>
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
          {connection.access === "read"
            ? "Your shop gave Agentify read-only access, so Agentify can't create orders there and agents can't buy. Connect again and approve Read/Write access."
            : "Your shop didn't grant Read/Write access, so Agentify can't create orders there and agents can't buy. Connect again and approve Read/Write access."}
          {connection.onCode && view.codeProducts !== 0
            ? ` When the shop connects, ${offSaleOnKeys(view.codeProducts)}.`
            : null}
        </p>
      </PanelHead>
      <ShopForm action="/woocommerce/connect" className="issue">
        {(pending) => (
          <>
            <input
              type="hidden"
              name="checked_shop"
              value={connection.shopUrl}
              autoComplete="off"
            />
            <input type="hidden" name="shop_url" value={connection.shopUrl} autoComplete="off" />
            <Button pending={pending}>Connect again</Button>
          </>
        )}
      </ShopForm>
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
      <ShopForm action="/woocommerce/switch" className="issue">
        {(pending) => <Button pending={pending}>Sell through this shop</Button>}
      </ShopForm>
    </section>
  );
}

/** Why Import is held, in a line under it, with the page that puts it right. */
function HeldLine({ held, base }: Readonly<{ held: ImportHeld; base: string }>) {
  switch (held.kind) {
    case "site":
      return <p className="quiet">Set your shop's site first.</p>;
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
      <ShopForm action="/woocommerce/import" className="issue">
        {(pending) => (
          <>
            <Button pending={pending} disabled={connection.held !== null}>
              Import products
            </Button>
            {connection.held === null ? null : <HeldLine held={connection.held} base={base} />}
          </>
        )}
      </ShopForm>
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
                    {withUnit(current.rate, rate.currency)} per US dollar
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
                {withUnit(reference.rate, rate.currency)} per US dollar, read{" "}
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
      <ShopForm
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
      </ShopForm>
    </section>
  );
}

export function Connected({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  const { rate } = connection;
  const site = connection.site;
  const needsSite = site !== null && site.kind !== "saved";
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
          wide={rate === null && connection.access === "read_write"}
          base={base}
        />,
        ...(rate !== null && !rateFirst ? [<RatePanel key="rate" rate={rate} />] : []),
      ];
  return (
    <>
      <Status connection={connection} view={view} base={base} />
      {site === null ? null : site.kind === "saved" ? (
        <p className={styles.site}>
          Buyers' agents will see {site.origin} as your shop's site.{" "}
          <a href={`${base}/settings`}>Change it in Settings</a>.
        </p>
      ) : site.kind === "invalid" ? (
        <div className={styles.site}>
          <p>
            {site.origin} can't be your shop's site
            {new URL(site.origin).port !== ""
              ? " because it has a port."
              : ". Set an https domain without a port in Settings."}
          </p>
          <a className="button button-primary" href={`${base}/settings`}>
            Set your site in Settings
          </a>
        </div>
      ) : (
        <div className={styles.site}>
          {site.problem === null ? null : (
            <p className="problem" role="alert">
              {site.problem}
            </p>
          )}
          <ShopForm action="/woocommerce/site" className="issue">
            {(pending) => <Button pending={pending}>Use {site.origin} as your shop's site</Button>}
          </ShopForm>
        </div>
      )}
      {needsSite ? null : (
        <div className="settings-grid">
          {connection.access !== "read_write" ? (
            <ReadOnlyPanel connection={connection} view={view} base={base} />
          ) : null}
          {panels}
        </div>
      )}
    </>
  );
}
