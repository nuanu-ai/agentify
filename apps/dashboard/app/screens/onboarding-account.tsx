import { Button, Field } from "@agentify/ui";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { OnboardingPress, OnboardingView } from "../../src/onboarding.js";
import type { ShopJobView } from "../../src/shop-job-view.js";
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
  job,
  beside,
}: Readonly<{
  job?: Pick<ShopJobView, "kind" | "status"> | null;
  view: OnboardingView;
  press?: OnboardingPress;
  publish?: Readonly<{ checkedJob: string; label: string }>;
  beside?: ReactNode;
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
  if (view.publicationPending) {
    const active = job?.status === "queued" || job?.status === "running";
    return (
      <>
        {press?.requestNeedsCheck ? null : problem}
        {active && job.kind === "publish" ? null : (
          <p role="status">
            {active ? account?.publication.checking : account?.publication.waiting}
          </p>
        )}
      </>
    );
  }
  if (!account?.active)
    return (
      <>
        {problem}
        {checkAgain}
        {beside}
      </>
    );
  const form = account.form;
  const name = press?.sellerName ?? account.sellerName;
  const wallet = press?.wallet ?? account.savedWallet ?? "";
  return (
    <section className={styles.account}>
      <section className="settings-panel">
        <div className="lede">
          <div>
            {problem}
            {account.heading && !account.decision ? <h2>{account.heading}</h2> : null}
            {account.sent ? (
              <>
                <p>
                  {account.sent.label}
                  <Moment at={account.sent.at} />.
                </p>
                <p>{account.sent.reply}</p>
              </>
            ) : null}
            {account.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </div>
        {!form || requestNeedsCheck ? (
          <div className="issue">
            <div className="step-actions">
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
              ) : null}
              {checkAgain}
              {beside}
            </div>
          </div>
        ) : null}
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
                      error={press?.nameProblem}
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
                      error={press?.walletProblem}
                    />
                    <WalletEcho box="payout_wallet" initial={wallet} />
                    <p>{account.wallet.commission}</p>
                  </>
                ) : null}
                <fieldset className="step-actions" disabled={pending}>
                  <Button pending={pending}>
                    {form.publish && publish ? publish.label : form.submit}
                  </Button>
                  {form.wallet &&
                  account.wallet?.coinbase != null &&
                  "chain" in account.wallet.coinbase ? (
                    <CoinbaseAddress
                      className={styles.walletAction}
                      chainId={account.wallet.coinbase.chain}
                      box="payout_wallet"
                      label={form.wallet.createWallet}
                      before={<span>{form.wallet.noWallet}</span>}
                    >
                      <p>{form.wallet.walletWindow}</p>
                    </CoinbaseAddress>
                  ) : account.wallet?.coinbase != null && "absent" in account.wallet.coinbase ? (
                    <p>{account.wallet.coinbase.absent}</p>
                  ) : null}
                  {beside}
                </fieldset>
              </>
            )}
          </PostForm>
        ) : null}
      </section>
    </section>
  );
}
