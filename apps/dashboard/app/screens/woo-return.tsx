import { Button } from "@agentify/ui";
import type { Chrome } from "../answer.js";
import { GatePage } from "../components/gate-page.js";

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
