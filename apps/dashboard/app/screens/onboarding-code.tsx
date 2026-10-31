import { Button } from "@agentify/ui";
import { useState } from "react";
import { Link } from "react-router";
import type { KeysView } from "../../src/keys.js";
import type { OnboardingView } from "../../src/onboarding.js";
import { Moment } from "../components/moment.js";
import { CreateKeyForm } from "./create-key.js";
import styles from "./onboarding.module.css";

// The disclosure loads with the creation form, before its button is available.
export { NewKeyScreen } from "./new-key.js";

function InstallCommand() {
  const [said, setSaid] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText("npm install @nuanu-ai/agentify");
      setSaid("Copied.");
    } catch {
      setSaid("Couldn't copy. Select the command and copy it.");
    }
  };
  return (
    <>
      <div className={styles.command}>
        <code>
          npm install <span className={styles.packageName}>@nuanu-ai/agentify</span>
        </code>
        <Button variant="secondary" type="button" onClick={() => void copy()}>
          Copy
        </Button>
      </div>
      <span role="status">{said}</span>
    </>
  );
}

export function CodeEntry({
  view,
  keyView,
}: Readonly<{ view: OnboardingView; keyView?: KeysView }>) {
  const { step } = view;
  const keys = keyView ?? view.keys;
  if (keys === null) return null;
  const working = keys.rows.filter((key) => key.revoked === null);
  const first = working[0];
  return (
    <section className={styles.code}>
      {step.otherWays ? (
        <p className={styles.back}>
          <Link to="/products?ways=choose">← Other ways to add products</Link>
        </p>
      ) : (
        <p>
          Your code hasn't connected yet.{" "}
          <Link to="/products" reloadDocument>
            Check again
          </Link>
          .
        </p>
      )}
      <h2>Add products with code</h2>
      <ol className={styles.steps}>
        <li>
          <h3>Install the package</h3>
          <p>It runs on Node.js 24 or later.</p>
          <InstallCommand />
        </li>
        <li>
          <h3>Create an API key</h3>
          {first === undefined ? (
            <CreateKeyForm view={keys} action="/products" />
          ) : (
            <>
              <p>
                {working.length === 1 ? (
                  <>
                    You have a key: “{first.label}”, created <Moment at={first.created} />.
                  </>
                ) : (
                  `You have ${working.length.toLocaleString("en-US")} keys.`
                )}
              </p>
              <p>
                If you no longer have it, create a new one on <Link to="/keys">API keys</Link> and
                revoke the old one.
              </p>
            </>
          )}
        </li>
        <li>
          <h3>Follow the quickstart</h3>
          <p>
            <a id="code-quickstart" href="/docs/quickstart">
              Open the quickstart
            </a>{" "}
            to publish your first product and answer its orders. Your code connects to{" "}
            <span className={styles.origin}>{view.origin}</span>.
          </p>
        </li>
      </ol>
    </section>
  );
}
