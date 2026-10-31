import { Button, Field } from "@agentify/ui";
import { Link } from "react-router";
import type { OnboardingPress, OnboardingView } from "../../src/onboarding.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { CoinbaseAddress } from "../wallet/address-button.js";
import { WalletEcho } from "../wallet/echo.js";
import styles from "./onboarding.module.css";

/** The same admission and first-wallet step sits between connection and products. */
export function OnboardingAccount({
  view,
  press,
  publish,
}: Readonly<{
  view: OnboardingView;
  press?: OnboardingPress;
  publish?: Readonly<{ checkedJob: string; label: string }>;
}>) {
  const account = view.account;
  const requestNeedsCheck = press?.requestNeedsCheck === true && view.unread;
  const problemText = press?.requestNeedsCheck
    ? view.unread
      ? press.problem
      : view.step.account === "request"
        ? press.requestResolvedProblem
        : null
    : press?.problem;
  const problem = problemText ? (
    <p role="alert" className="problem">
      {problemText}
      {press?.requestNeedsCheck ? null : (
        <>
          {" "}
          <Link to="/settings">Settings</Link>
        </>
      )}
    </p>
  ) : null;
  const checkAgain = requestNeedsCheck ? (
    <Link className="button button-primary" reloadDocument to="/products">
      Check again
    </Link>
  ) : null;
  if (!account?.active)
    return (
      <>
        {problem}
        {checkAgain}
      </>
    );
  const form = account.form;
  const name = press?.sellerName ?? account.sellerName;
  const wallet = press?.wallet ?? account.savedWallet ?? "";
  return (
    <section className={styles.account}>
      {requestNeedsCheck || account.link?.problem ? problem : null}
      {account.heading ? <h2>{account.heading}</h2> : null}
      {account.sent ? (
        <>
          <p>
            {account.sent.label}
            <Moment at={account.sent.at} />.
          </p>
          <p>{account.sent.reply}</p>
        </>
      ) : null}
      {account.decision ? (
        <>
          <p>
            {account.decision.label}
            <Moment at={account.decision.at} />.
          </p>
          {account.decision.note === null ? null : (
            <div className={styles.note}>
              <p>{account.decision.noteLabel}</p>
              <p>{account.decision.note}</p>
            </div>
          )}
        </>
      ) : null}
      {account.paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {account.link ? (
        account.link.external ? (
          <a className="button button-primary" href={account.link.href}>
            {account.link.label}
          </a>
        ) : (
          <Link className="button button-primary" to={account.link.href}>
            {account.link.label}
          </Link>
        )
      ) : requestNeedsCheck ? null : (
        problem
      )}
      {checkAgain}
      {form && !requestNeedsCheck ? (
        <PostForm document action="/products" className={`issue ${styles.profile}`}>
          {(pending) => (
            <>
              <input type="hidden" name="intent" value={form.intent} />
              {form.publish && publish ? (
                <input type="hidden" name="checked_job" value={publish.checkedJob} />
              ) : null}
              {form.name ? (
                <>
                  <p>{form.name.explanation}</p>
                  <Field
                    label={form.name.label}
                    id="seller_name"
                    name="seller_name"
                    autoComplete="organization"
                    defaultValue={name}
                    required
                    hint={account.nameRule}
                    {...(press?.nameProblem === undefined ? {} : { error: press.nameProblem })}
                  />
                </>
              ) : null}
              {form.wallet && account.wallet !== null ? (
                <>
                  <p>{account.wallet.purpose}</p>
                  <p>{form.wallet.explanation}</p>
                  <Field
                    label={form.wallet.label}
                    id="payout_wallet"
                    name="payout_wallet"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="0x…"
                    defaultValue={wallet}
                    required
                    hint={account.wallet.rule}
                    {...(press?.walletProblem === undefined ? {} : { error: press.walletProblem })}
                  />
                  <WalletEcho box="payout_wallet" initial={wallet} />
                  {account.wallet.coinbase !== null && "chain" in account.wallet.coinbase ? (
                    <CoinbaseAddress
                      chainId={account.wallet.coinbase.chain}
                      box="payout_wallet"
                      label={form.wallet.createWallet}
                      before={<span>{form.wallet.noWallet}</span>}
                    >
                      <p>{form.wallet.walletWindow}</p>
                    </CoinbaseAddress>
                  ) : account.wallet.coinbase !== null && "absent" in account.wallet.coinbase ? (
                    <p>{account.wallet.coinbase.absent}</p>
                  ) : null}
                  <p>{account.wallet.commission}</p>
                </>
              ) : null}
              <Button pending={pending}>
                {form.publish && publish ? publish.label : form.submit}
              </Button>
            </>
          )}
        </PostForm>
      ) : null}
    </section>
  );
}
