import type { ReactNode } from "react";
import type { IntegrationsView, ShopTileView } from "../../src/integrations-view.js";
import type { Word as WordView } from "../../src/words.js";
import { Moment } from "../components/moment.js";
import { Word } from "../components/word.js";
import styles from "./integrations.module.css";

const IN_USE: WordView = { text: "In use", tone: "ok" };
const IN_USE_UNSOLD: WordView = { text: "In use", tone: "warn" };
const CONNECTED: WordView = { text: "Connected", tone: "ok" };
const NO_READ_WRITE: WordView = { text: "No Read/Write access", tone: "warn" };

/** A way in: its name, the mark where sales go through it, its words and its one action. */
function Way({
  name,
  inUse,
  children,
}: Readonly<{ name: string; inUse: WordView | null; children: ReactNode }>) {
  return (
    <div className="connect-way">
      <div className={styles.head}>
        <h2>{name}</h2>
        {inUse === null ? null : <Word word={inUse} />}
      </div>
      {children}
    </div>
  );
}

function Go({
  to,
  primary,
  children,
}: Readonly<{ to: string; primary: boolean; children: string }>) {
  return (
    <div className="connect-actions">
      <a className={primary ? "button button-primary" : "button button-secondary"} href={to}>
        {children}
      </a>
    </div>
  );
}

/**
 * Every action is on the shop's own screen, which this block leads to, except
 * where the connection could not be read: that screen needs the same read and
 * would fail too, so the block offers the read again.
 */
function ShopTile({
  tile,
  primary,
  sellsElsewhere,
  base,
}: Readonly<{ tile: ShopTileView; primary: boolean; sellsElsewhere: boolean; base: string }>) {
  const shop = `${base}/woocommerce`;
  switch (tile.kind) {
    case "unread":
      return (
        <>
          <p>We couldn't check your shop connection.</p>
          <Go to={`${base}/integrations`} primary={false}>
            Reload
          </Go>
        </>
      );
    case "connected":
      return (
        <>
          <p className={styles.state}>
            <Word word={tile.readOnly ? NO_READ_WRITE : CONNECTED} />
            <span className={styles.shop}>{tile.shop}</span>
            <span>
              since <Moment at={tile.connectedAt} />
            </span>
          </p>
          {tile.readOnly ? (
            <p>
              Agents can't buy: your shop didn't grant Read/Write access. Connect again and approve
              Read/Write.
            </p>
          ) : sellsElsewhere ? (
            <p>Its products are off sale while you sell through your own code.</p>
          ) : null}
          <Go to={shop} primary={primary}>
            {tile.readOnly ? "Connect again" : "Open WooCommerce page"}
          </Go>
        </>
      );
    case "none":
      return (
        <>
          <p>Import downloads and parcels from your WooCommerce shop.</p>
          <Go to={shop} primary={primary}>
            Connect a shop
          </Go>
        </>
      );
    case "not-arrived":
      return (
        <>
          <div className="callout">
            <div className="what">{tile.what}</div>
            <p className="why">{tile.why}</p>
          </div>
          <Go to={shop} primary={primary}>
            {tile.next}
          </Go>
        </>
      );
  }
}

export function IntegrationsScreen({
  view,
  base,
}: Readonly<{ view: IntegrationsView; base: string }>) {
  const { inUse } = view;
  return (
    <>
      <div className="lede">
        <div>
          <p>{view.lede}</p>
          {view.throughUnread ? (
            <p>
              Which way you sell through couldn't be read just now. Reload the page in a moment.
            </p>
          ) : null}
        </div>
      </div>
      <div className="settings-grid">
        <section
          className={
            view.shop === null
              ? "settings-panel settings-connect"
              : "settings-panel settings-wide settings-connect"
          }
        >
          <div className={view.shop === null ? `connect-ways ${styles.alone}` : "connect-ways"}>
            <Way name="Your own code" inUse={inUse === "api" ? IN_USE : null}>
              <p>
                Publish products and handle orders from your Node.js code with the{" "}
                <code className={styles.package}>@nuanu-ai/agentify</code> package.
              </p>
              <div className="connect-actions">
                <a
                  className={
                    inUse === "woocommerce" ? "button button-secondary" : "button button-primary"
                  }
                  href="/docs/quickstart"
                >
                  Open the connection guide
                </a>
                <a className="button button-secondary" href={`${base}/keys?new=key`}>
                  Create an API key
                </a>
              </div>
            </Way>
            {view.shop === null ? null : (
              <Way
                name="WooCommerce"
                inUse={inUse !== "woocommerce" ? null : view.nothingSells ? IN_USE_UNSOLD : IN_USE}
              >
                {view.nothingSells ? <p>Nothing sells until a shop is connected.</p> : null}
                <ShopTile
                  tile={view.shop}
                  primary={inUse !== "api"}
                  sellsElsewhere={inUse === "api"}
                  base={base}
                />
              </Way>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
