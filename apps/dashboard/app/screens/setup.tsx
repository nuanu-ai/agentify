/**
 * A new merchant's setup, on cards outside the dashboard's frame: the one
 * control that makes a merchant, and the name buyers read. Skipping the name is
 * allowed, but never silently: until a name is set, publishing a card is
 * refused, and every screen a merchant works on says so with a way to fix it.
 */

import { Button, Field } from "@agentify/ui";
import { useEffect, useState } from "react";
import type { ChooseNameView, MerchantView } from "../../src/page-services.js";
import type { Chrome } from "../answer.js";
import { GatePage } from "../components/gate-page.js";
import { PostForm } from "../components/post-form.js";
// The cards in front of the dashboard keep one rhythm, the sign-in's.
import styles from "./sign-in.module.css";

/**
 * Only the same-origin press makes the merchant: an account is made at sign-in,
 * and the scanner signs people in too, so a merchant is made only for somebody
 * who asked the dashboard for one. A press that did not make one leaves the
 * person here, signed in, to press again. The header names who is signed in.
 */
export function MerchantScreen({ chrome, view }: Readonly<{ chrome: Chrome; view: MerchantView }>) {
  return (
    <GatePage chrome={chrome} title="Sell to AI agents">
      <div className={`gate-card ${styles.card}`}>
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
      </div>
    </GatePage>
  );
}

/**
 * No navigation: this is the last step of first-time setup. Choosing later is a
 * link to the cards, where the same missing-name notice waits with the page that
 * fixes it. The advice is against the common mistake, a description of the
 * goods, because a catalogue written into this box becomes the listing name and
 * nothing further down the line corrects it.
 *
 * With the box empty the only way on is to choose later, so the button waits
 * for a name. It is served pressable, as every button that waits here is,
 * because nothing could enable it again where the page's script did not run;
 * the server refuses an empty name for that browser.
 */
export function ChooseNameScreen({
  chrome,
  view,
}: Readonly<{ chrome: Chrome; view: ChooseNameView }>) {
  const [typed, setTyped] = useState(view.typed);
  const [alive, setAlive] = useState(false);
  useEffect(() => setAlive(true), []);
  // The rule is the box's line until something is refused; then the refusal
  // is, and the rule follows it unless the refusal already says it.
  const line =
    view.problem === undefined
      ? view.rule === null
        ? {}
        : { hint: view.rule }
      : { error: view.problem };
  return (
    <GatePage chrome={chrome} title="Choose a seller name">
      <PostForm className={`gate-card ${styles.card}`} action="/choose-name">
        {(pending) => (
          <>
            <h1>Choose a seller name</h1>
            <p>
              Buyers see it beside your products and in every payment they approve, so use the name
              people know you by. You can change it later.
            </p>
            <Field
              label="Seller name"
              id="seller_name"
              name="seller_name"
              type="text"
              autoComplete="organization"
              maxLength={32}
              defaultValue={view.typed}
              autoFocus
              required
              onChange={(event) => setTyped(event.currentTarget.value)}
              {...line}
            />
            {view.problem !== undefined && view.rule !== null ? (
              <p className="quiet">{view.rule}</p>
            ) : null}
            <Button pending={pending} disabled={alive && typed.trim() === ""}>
              Use this name
            </Button>
            <p className={`quiet gate-skip ${styles.foot}`}>
              <a href={`${chrome.base}/cards`}>Choose later</a>. Nothing goes on sale until you do.
            </p>
          </>
        )}
      </PostForm>
    </GatePage>
  );
}
