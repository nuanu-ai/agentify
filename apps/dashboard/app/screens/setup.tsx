/** The first seller-dashboard opening for a signed-in account with no merchant. */

import { Button } from "@agentify/ui";
import { useRouteLoaderData } from "react-router";
import type { MerchantView } from "../../src/page-services.js";
import type { Chrome } from "../answer.js";
import { GatePage } from "../components/gate-page.js";
import { PostForm } from "../components/post-form.js";
// The cards in front of the dashboard keep one rhythm, the sign-in's.
import styles from "./sign-in.module.css";

/**
 * For a person signed in somewhere other than the dashboard's own sign-in page:
 * the scanner signs people in too, and only this same-origin press asks the
 * dashboard for their merchant. A sign-in on that page makes the merchant
 * itself and comes here only when it could not, as a press that did not make
 * one does, to press again. The card names the address the merchant will
 * belong to, because the header hides it on a phone.
 */
export function MerchantScreen({ chrome, view }: Readonly<{ chrome: Chrome; view: MerchantView }>) {
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  if (gate === undefined) {
    throw new Error("the merchant screen was drawn outside the gate, where no address is known");
  }
  return (
    <GatePage chrome={chrome} title="Sell to AI agents">
      <div className={`message-panel ${styles.card}`}>
        <h1>Sell to AI agents</h1>
        {view.unavailable ? (
          <p className="problem">
            Your seller dashboard did not open because of a fault on our side. Try again.
          </p>
        ) : (
          <p>
            Your seller dashboard holds the products you offer to AI agents and the orders they
            place.
          </p>
        )}
        <PostForm action="/merchant">
          {(pending) => <Button pending={pending}>Open my seller dashboard</Button>}
        </PostForm>
        <p className={`quiet ${styles.caption}`}>
          Signed in as <strong>{gate.who}</strong>.
        </p>
      </div>
    </GatePage>
  );
}
