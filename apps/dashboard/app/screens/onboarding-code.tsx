import { Link } from "react-router";
import type { KeysView } from "../../src/keys.js";
import type { OnboardingView } from "../../src/onboarding.js";
import { Moment } from "../components/moment.js";
import { CommandCopy } from "../display/copy.js";
import { CreateKeyForm } from "./create-key.js";
import styles from "./onboarding.module.css";

// The disclosure loads with the creation form, before its button is available.
export { NewKeyScreen } from "./new-key.js";

function InstallCommand() {
  return (
    <div className={styles.command}>
      <code>
        npm install <span className={styles.packageName}>@nuanu-ai/agentify</span>
      </code>
      <CommandCopy value="npm install @nuanu-ai/agentify" />
    </div>
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
    <>
      {step.otherWays ? (
        <p className={styles.back}>
          <Link to="/products?ways=choose">Other ways to add products</Link>
        </p>
      ) : null}
      <section className={`settings-panel ${styles.code}`}>
        {!step.otherWays ? <p>Your code hasn't connected yet.</p> : null}
        <h2>Add products with code</h2>
        <ol className={styles.steps}>
          <li>
            <h3>Install the package</h3>
            <InstallCommand />
            <p>It runs on Node.js 24 or later.</p>
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
        {!step.otherWays ? (
          <div className="step-actions">
            <Link className="button button-secondary" to="/products" reloadDocument>
              Check again
            </Link>
          </div>
        ) : null}
      </section>
    </>
  );
}
