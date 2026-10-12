import type { IntegrationsView, ShopTileView } from "../../src/integrations-view.js";
import { Moment } from "../components/moment.js";

/**
 * Every action is on the shop's own screen, which this block leads to, except
 * where the connection could not be read: that screen needs the same read and
 * would fail too.
 */
function ShopTile({ tile, base }: Readonly<{ tile: ShopTileView; base: string }>) {
  const shop = `${base}/woocommerce`;
  switch (tile.kind) {
    case "unread":
      return (
        <>
          <h3>WooCommerce</h3>
          <p>Whether a shop is connected to this account could not be read just now.</p>
          <p className="quiet">
            The fault is on our side, not in your shop, and nothing was disconnected by it. Reload
            this page in a moment.
          </p>
        </>
      );
    case "connected":
      return (
        <>
          <h3>WooCommerce</h3>
          <p>
            {tile.shopUrl}, connected <Moment at={tile.connectedAt} />.
          </p>
          {tile.narrower === null ? null : (
            <p className="problem">
              Your shop granted {tile.narrower} access rather than read and write, so a fresh
              purchase is unavailable before payment. Connect again and approve read and write
              access.
            </p>
          )}
          <div className="connect-actions">
            <a className="button button-secondary" href={shop}>
              Your shop
            </a>
          </div>
        </>
      );
    case "none":
      return (
        <>
          <h3>WooCommerce</h3>
          <p>
            The connector imports two narrow WooCommerce configurations, a download and a parcel,
            which the shop screen describes. You sell through it or through your own code, one at a
            time.
          </p>
          <div className="connect-actions">
            <a className="button button-primary" href={shop}>
              Connect a WooCommerce shop
            </a>
          </div>
        </>
      );
    case "not-arrived":
      return (
        <>
          <h3>WooCommerce</h3>
          <div className="callout">
            <div className="what">{tile.what}</div>
            <div className="why">{tile.why}</div>
          </div>
          <div className="connect-actions">
            <a className="button button-primary" href={shop}>
              {tile.next}
            </a>
          </div>
        </>
      );
  }
}

export function IntegrationsScreen({
  view,
  base,
}: Readonly<{ view: IntegrationsView; base: string }>) {
  return (
    <>
      <div className="lede">
        <div>
          <p>{view.lede}</p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="settings-panel settings-wide settings-connect">
          <div className="connect-ways">
            <div className="connect-way">
              <h3>The SDK</h3>
              <p className="quiet">
                Your developer installs the <code>@nuanu-ai/agentify</code> package in a Node.js
                service, publishes cards with an API key, and handles paid orders in your own code.
              </p>
              <div className="connect-actions">
                <a className="button button-primary" href="/docs/quickstart">
                  Open the connection guide
                </a>
                <a className="button button-secondary" href={`${base}/keys?new=key`}>
                  Create an API key
                </a>
              </div>
            </div>
            {view.shop === null ? null : (
              <div className="connect-way">
                <ShopTile tile={view.shop} base={base} />
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
