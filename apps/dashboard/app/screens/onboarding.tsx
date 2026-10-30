import { Button, Field } from "@agentify/ui";
import { useEffect, useState } from "react";
import { Link, useRevalidator, useSearchParams } from "react-router";
import type { KeysView } from "../../src/keys.js";
import type { Platform } from "../../src/next-step.js";
import type { OnboardingView } from "../../src/onboarding.js";
import wooMark from "../assets/woocommerce.png";
import { LockedDialog } from "../components/locked-dialog.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import styles from "./onboarding.module.css";

const PLATFORMS = [
  { value: "woocommerce", title: "WooCommerce", line: "Connect your shop. No code needed." },
  {
    value: "api",
    title: "With code",
    line: "You or a developer publish products through our API.",
  },
  { value: "other", title: "Another platform", line: "Shopify, Wix, Squarespace and others." },
] as const;

function PlatformMark({ platform }: Readonly<{ platform: string }>) {
  return platform === "woocommerce" ? (
    <img src={wooMark} alt="" className={styles.wooMark} />
  ) : (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {platform === "api" ? (
        <path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16" />
      ) : (
        <>
          <path d="M3 10h18L19 4H5l-2 6Zm1 0v10h16V10M9 20v-7h6v7" />
          <path d="M3 10c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0" />
        </>
      )}
    </svg>
  );
}

function PlatformChoice({
  practice,
  problem,
  selected,
}: Readonly<{ practice: boolean; problem?: string; selected?: Platform }>) {
  return (
    <section className={styles.start}>
      <h2>How do you want to add your products?</h2>
      <PostForm action="/products" className={styles.choices}>
        {(pending) =>
          PLATFORMS.map((platform) => (
            <button
              key={platform.value}
              type="submit"
              name="platform"
              data-platform={platform.value}
              data-selected={selected === platform.value ? true : undefined}
              value={platform.value}
              className={styles.choice}
              disabled={pending}
            >
              <span className={styles.mark}>
                <PlatformMark platform={platform.value} />
              </span>
              <span>
                <strong>{platform.title}</strong>
                <span>{platform.line}</span>
              </span>
            </button>
          ))
        }
      </PostForm>
      {problem === undefined ? null : (
        <p role="alert" className="problem">
          {problem}
        </p>
      )}
      {practice ? (
        <p className={styles.practice}>
          <a href="/docs/#how-to-start">Want to practice first?</a>
        </p>
      ) : null}
    </section>
  );
}

export function TestWelcome({ problem }: Readonly<{ problem?: string }>) {
  const [understood, setUnderstood] = useState(false);
  const [alive, setAlive] = useState(false);
  useEffect(() => setAlive(true), []);
  return (
    <LockedDialog
      title="This is the test environment"
      focusAfter='button[data-platform="woocommerce"]'
    >
      <ul className={styles.testFacts}>
        <li>Money here isn't real. Buyers pay in test USDC on Base Sepolia.</li>
        <li>
          This is a separate account. Nothing here carries over to your real dashboard at
          agentify.ad.
        </li>
        <li>If you connect your real shop, orders made here are test orders. Don't ship them.</li>
      </ul>
      <PostForm action="/products">
        {(pending) => (
          <>
            <input type="hidden" name="intent" value="acknowledge-test" />
            <label className={styles.check}>
              <input
                type="checkbox"
                name="understood"
                value="yes"
                required
                checked={understood}
                onChange={(event) => setUnderstood(event.target.checked)}
              />
              I've read and understood
            </label>
            <Button pending={pending} disabled={alive && !understood}>
              Start testing
            </Button>
            {problem === undefined ? null : (
              <p className="problem" role="alert">
                {problem}
              </p>
            )}
          </>
        )}
      </PostForm>
    </LockedDialog>
  );
}

export function CreateKeyForm({ view, action }: Readonly<{ view: KeysView; action: string }>) {
  return (
    <PostForm action={action} className={styles.keyForm} replace={false}>
      {(pending) => (
        <>
          <input type="hidden" name="intent" value="create-key" />
          <Field
            label="Key name"
            id="label"
            name="label"
            type="text"
            autoComplete="off"
            placeholder="Order worker, production"
            maxLength={100}
            defaultValue={view.typed}
            autoFocus={view.startNew}
            required
            {...(view.problem === null ? {} : { error: view.problem })}
          />
          <Button id="create-api-key" pending={pending}>
            Create key
          </Button>
        </>
      )}
    </PostForm>
  );
}

function OtherWays() {
  return (
    <p className={styles.back}>
      <Link to="/products?ways=choose">← Other ways to add products</Link>
    </p>
  );
}

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

export function OnboardingScreen({
  view,
  problem,
  keyView,
  choose = false,
  selected,
}: Readonly<{
  view: OnboardingView;
  problem?: string;
  keyView?: KeysView;
  choose?: boolean;
  selected?: Platform;
}>) {
  const { step } = view;
  const [query] = useSearchParams();
  const choosing =
    choose ||
    (query.get("ways") === "choose" &&
      (step.page === "other" || (step.page === "code" && view.keys?.rows.length === 0)));
  const revalidator = useRevalidator();
  useEffect(() => {
    if (step.page !== "code" || !view.keys?.rows.some((key) => key.revoked === null)) return;
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle" &&
        document.querySelector("dialog[open]") === null
      )
        void revalidator.revalidate();
    }, 10_000);
    return () => clearInterval(timer);
  }, [step.page, view.keys, revalidator]);
  if (view.unread)
    return (
      <p>
        We could not read your next step.{" "}
        <Link to="/products" reloadDocument>
          Check again
        </Link>
        .
      </p>
    );
  if (step.page === "platform" || choosing)
    return (
      <PlatformChoice
        practice={step.practice}
        {...(problem === undefined ? {} : { problem })}
        {...(selected === undefined ? {} : { selected })}
      />
    );
  if (step.page === "other")
    return (
      <section className={styles.code}>
        <OtherWays />
        <h2>We can't connect your platform automatically yet</h2>
        <p>
          You can still sell through Agentify: a developer, or an AI coding assistant, connects your
          shop to our API. They start from the <a href="/docs/quickstart">quickstart</a>.
        </p>
        <PostForm action="/products">
          {(pending) => (
            <Button pending={pending} name="platform" value="api">
              Set it up with code
            </Button>
          )}
        </PostForm>
      </section>
    );
  if (step.page === "code-silent")
    return (
      <section className={styles.code}>
        <p className={styles.connection} data-stale>
          Your code last connected {view.contact === null ? "" : <Moment at={view.contact} />}.
        </p>
        <p>
          Agentify{" "}
          <a href="/docs/failures#your-integration-has-not-connected">hasn't heard from it</a>{" "}
          since.
        </p>
      </section>
    );
  if (step.page === "code-connected")
    return (
      <section className={styles.code}>
        <p className={styles.connection}>
          Your code connected {view.contact === null ? "" : <Moment at={view.contact} />}
        </p>
        {step.profileStep !== null ? (
          <>
            <p>
              Before publishing,{" "}
              {step.profileStep === "seller-name"
                ? "choose the seller name buyers see"
                : view.mode === "test"
                  ? "add your test wallet"
                  : "add your payout wallet"}{" "}
              in Settings.
            </p>
            <Link className="button button-primary" to="/settings">
              Open Settings
            </Link>
          </>
        ) : step.approvalNeeded ? (
          <p>
            Live sales start once Agentify approves your shop. To ask, write to{" "}
            <a href="mailto:admin@agentify.ad">admin@agentify.ad</a>.
          </p>
        ) : (
          <>
            <p>Publish your products from your code.</p>
            <a className="button button-primary" href="/docs/quickstart#_4-publish-one-card">
              Open the publishing guide
            </a>
          </>
        )}
      </section>
    );
  const keys = keyView ?? view.keys;
  if (keys === null) return null;
  const working = keys.rows.filter((key) => key.revoked === null);
  const first = working[0];
  return (
    <section className={styles.code}>
      {keys.rows.length === 0 ? (
        <OtherWays />
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
