/**
 * A new merchant's setup, on cards outside the dashboard's frame: the one
 * control that makes a merchant, and the name buyers read. Skipping the name is
 * allowed, but never silently: until a name is set, publishing a card is
 * refused, and every screen a merchant works on says so with a way to fix it.
 */

import { Button, Field } from "@agentify/ui";
import { useRouteLoaderData } from "react-router";
import type { ChooseNameView, MerchantView } from "../../src/page-services.js";
import type { Chrome } from "../answer.js";
import { GatePage } from "../components/gate-page.js";
import { PostForm } from "../components/post-form.js";

/**
 * Only the same-origin press makes the merchant; a press that did not make one
 * leaves the person here, signed in, to press again.
 */
export function MerchantScreen({ chrome, view }: Readonly<{ chrome: Chrome; view: MerchantView }>) {
  const gate = useRouteLoaderData<{ who: string }>("routes/gate");
  if (gate === undefined) {
    throw new Error("the merchant screen was drawn outside the gate, where no address is known");
  }
  return (
    <GatePage chrome={chrome} title="Open a seller dashboard">
      <div className="gate-card">
        <h1>Open a seller dashboard</h1>
        <p>
          You are signed in as <strong>{gate.who}</strong>.
        </p>
        {view.unavailable ? (
          <p className="problem">
            Your seller dashboard was not opened because of a fault on our side. You are still
            signed in, so pressing again needs no new link.
          </p>
        ) : (
          <p>
            A seller dashboard is where your engineer publishes what you sell to agents and where
            the orders arrive. Nothing is made until you press the button.
          </p>
        )}
        <PostForm action="/merchant">
          {(pending) => <Button pending={pending}>Open my seller dashboard</Button>}
        </PostForm>
      </div>
    </GatePage>
  );
}

/**
 * No navigation: this is the last step of first-time setup. Skipping is a link
 * to the cards, where the same missing-name notice waits with the page that
 * fixes it. The example is the shape of the common mistake: the name people
 * already know, not a description of the goods, because a catalogue written
 * into this box becomes the listing name and nothing further down the line
 * corrects it.
 */
export function ChooseNameScreen({
  chrome,
  view,
}: Readonly<{ chrome: Chrome; view: ChooseNameView }>) {
  // The rule is the box's line until something is refused; then the refusal
  // is, and the rule follows it unless the refusal already says it.
  const line =
    view.problem === undefined
      ? view.rule === null
        ? {}
        : { hint: view.rule }
      : { error: view.problem };
  return (
    <GatePage chrome={chrome} title="The name your products are sold under">
      <PostForm className="gate-card" action="/choose-name">
        {(pending) => (
          <>
            <h1>Choose your seller name</h1>
            <p>Your account is ready. Choose the seller name buyers will see.</p>
            <Field
              label="The name your products are sold under"
              id="seller_name"
              name="seller_name"
              type="text"
              autoComplete="organization"
              maxLength={32}
              defaultValue={view.typed}
              autoFocus
              required
              {...line}
            />
            {view.problem !== undefined && view.rule !== null ? (
              <p className="quiet">{view.rule}</p>
            ) : null}
            <Button pending={pending}>Use this name</Button>
            <p>
              Buyers see this seller name beside your products and in the payment they approve. Use
              the name people already know you by, rather than a description of what you sell.
            </p>
            <p className="quiet">
              You can change it in <a href={`${chrome.base}/settings`}>Settings</a>; until it is
              set, nothing you publish goes on sale.
            </p>
            <p className="quiet gate-skip">
              Not decided yet? <a href={`${chrome.base}/cards`}>Leave it for now</a>.
            </p>
          </>
        )}
      </PostForm>
    </GatePage>
  );
}
