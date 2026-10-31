import { Button } from "@agentify/ui";
import { lazy, Suspense, useEffect } from "react";
import { Link, useRevalidator, useSearchParams } from "react-router";
import type { KeysView } from "../../src/keys.js";
import type { Platform } from "../../src/next-step.js";
import type { OnboardingPress, OnboardingView } from "../../src/onboarding.js";
import wooMark from "../assets/woocommerce.png";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Word } from "../components/word.js";
import styles from "./onboarding.module.css";

const CodeEntry = lazy(() =>
  import("./onboarding-code.js").then(({ CodeEntry }) => ({ default: CodeEntry })),
);

const OnboardingAccount = lazy(() =>
  import("./onboarding-account.js").then(({ OnboardingAccount }) => ({
    default: OnboardingAccount,
  })),
);

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
          <Link to="/practice" reloadDocument prefetch="none">
            Want to practice first?
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function OtherWays() {
  return (
    <p className={styles.back}>
      <Link to="/products?ways=choose">Other ways to add products</Link>
    </p>
  );
}

export function OnboardingScreen({
  view,
  problem,
  keyView,
  choose = false,
  selected,
  press,
}: Readonly<{
  press?: OnboardingPress;
  view: OnboardingView;
  problem?: string;
  keyView?: KeysView;
  choose?: boolean;
  selected?: Platform;
}>) {
  const { step } = view;
  const [query] = useSearchParams();
  const choosing =
    step.otherWays &&
    (choose ||
      (query.get("ways") === "choose" &&
        (step.page === "other" || (step.page === "code" && view.keys?.rows.length === 0))));
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
    return press?.requestNeedsCheck === true && press.problem !== null ? (
      <>
        <p role="alert" className="problem">
          {press.problem}
        </p>
        <Link className="button button-primary" to="/products" reloadDocument>
          Check again
        </Link>
      </>
    ) : (
      <p>
        We could not read your next step.{" "}
        <Link to="/products" reloadDocument>
          Check again
        </Link>
        .
      </p>
    );
  if (
    ["pending", "declined", "withdrawn"].includes(step.account) &&
    step.page !== "shop" &&
    step.page !== "code-connected" &&
    step.page !== "code-silent"
  )
    return (
      <Suspense fallback={null}>
        <OnboardingAccount view={view} {...(press === undefined ? {} : { press })} />
      </Suspense>
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
      <>
        <OtherWays />
        <section className={`settings-panel ${styles.code}`}>
          <h2>We can't connect your platform automatically yet</h2>
          <p>
            You can still sell through Agentify: a developer, or an AI coding assistant, connects
            your shop to our API. They start from the <a href="/docs/quickstart">quickstart</a>.
          </p>
          <PostForm action="/products" className="step-actions">
            {(pending) => (
              <Button pending={pending} name="platform" value="api">
                Set it up with code
              </Button>
            )}
          </PostForm>
        </section>
      </>
    );
  if (step.page === "code-silent")
    return (
      <section className={styles.codeState}>
        <p className={styles.connection}>
          <Word word={{ text: "Your code last connected", tone: "waiting" }} />
          <span>{view.contact === null ? "" : <Moment at={view.contact} />}</span>
        </p>
        <p>
          Agentify{" "}
          <a href="/docs/failures#your-integration-has-not-connected">hasn't heard from it</a>{" "}
          since.
        </p>
        {step.account === "none" && !press?.problem ? null : (
          <Suspense fallback={null}>
            <OnboardingAccount view={view} {...(press === undefined ? {} : { press })} />
          </Suspense>
        )}
      </section>
    );
  if (step.page === "code-connected")
    return (
      <section className={styles.codeState}>
        <p className={styles.connection}>
          <Word word={{ text: "Your code connected", tone: "ok" }} />
          <span>{view.contact === null ? "" : <Moment at={view.contact} />}</span>
        </p>
        {step.account === "none" && !press?.problem ? null : (
          <Suspense fallback={null}>
            <OnboardingAccount view={view} {...(press === undefined ? {} : { press })} />
          </Suspense>
        )}
      </section>
    );
  return (
    <Suspense fallback={null}>
      <CodeEntry view={view} {...(keyView === undefined ? {} : { keyView })} />
    </Suspense>
  );
}
