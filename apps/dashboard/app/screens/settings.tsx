import { Button, Field } from "@agentify/ui";
import { type ReactNode, useState } from "react";
import { NAME_RULE, SITE_RULE } from "../../src/seller-name.js";
import type {
  PayoutView,
  SettingsView,
  SplitView,
  WalletNoticeView,
  WalletView,
} from "../../src/settings-view.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Address } from "../wallet/address.js";
import { CoinbaseAddress, CoinbasePayout } from "../wallet/buttons.js";
import { WalletEcho } from "../wallet/echo.js";
import styles from "./settings.module.css";

/** A section's heading and the line under it that says what the section is for. */
function Head({
  id,
  title,
  children,
}: Readonly<{ id: string; title: string; children: ReactNode }>) {
  return (
    <div className={styles.head}>
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  );
}

/** The name buyers read beside every product, and the site agents send buyers to. */
function WhatBuyersSee({ view }: Readonly<{ view: SettingsView }>) {
  const { name, site } = view;
  return (
    <section className={`settings-panel ${styles.section}`} aria-labelledby="what-buyers-see">
      <Head id="what-buyers-see" title="What buyers see">
        {view.approved ? <p>Agentify has approved your business for live sales.</p> : null}
      </Head>
      <PostForm document action="/settings" className="issue">
        {(pending) => (
          <>
            <p className={styles.purpose}>
              Buyers see this name next to your products and in the payment they approve.
            </p>
            <Field
              label="Seller name"
              id="seller_name"
              name="seller_name"
              type="text"
              autoComplete="organization"
              maxLength={32}
              defaultValue={name.value}
              required
              hint={NAME_RULE}
              {...(name.problem === null ? {} : { error: name.problem })}
            />
            <Button pending={pending}>Save</Button>
          </>
        )}
      </PostForm>
      <PostForm document action="/settings/site" className="issue">
        {(pending) => (
          <>
            <p className={styles.purpose}>
              Agents give buyers this address for what an order can't answer: a delivery that didn't
              arrive, a return, your terms.
            </p>
            <Field
              label="Shop's site"
              id="seller_site"
              name="seller_site"
              type="url"
              autoComplete="url"
              inputMode="url"
              placeholder="https://yourshop.com"
              defaultValue={site.value}
              required
              hint={SITE_RULE}
              {...(site.problem === null ? {} : { error: site.problem })}
            />
            <Button pending={pending}>Save</Button>
          </>
        )}
      </PostForm>
    </section>
  );
}

/**
 * The waiting change a page showed and the address paid beside it, carried by
 * both wallet forms so a press arriving after that change took effect is told
 * apart from a cancel.
 */
function Shown({
  pending,
  saved,
}: Readonly<{ pending: NonNullable<WalletView["pending"]>; saved: string | null }>) {
  return (
    <>
      <input type="hidden" name="waiting" value={pending.wallet} />
      <input type="hidden" name="waiting_from" value={pending.takesEffectAt} />
      <input type="hidden" name="paid" value={saved ?? ""} />
    </>
  );
}

/**
 * The change waiting, first in its section and always shown, because the
 * message announcing it says it takes effect only if this screen shows it.
 */
function Waiting({
  pending,
  saved,
}: Readonly<{ pending: NonNullable<WalletView["pending"]>; saved: string | null }>) {
  return (
    <div className={`${styles.notice} ${styles.warn}`}>
      <p className={styles.noticeHead}>Your payout wallet is changing</p>
      <p>
        From <Moment at={pending.from} />, your share of each sale goes to{" "}
        <Address address={pending.wallet} />.
      </p>
      <p>
        If nobody at your business asked for this, cancel it. Cancelling also signs out every other
        session on your account.
      </p>
      <PostForm document action="/settings/payout-wallet/cancel" className={styles.noticeAction}>
        {(pressed) => (
          <>
            <Shown pending={pending} saved={saved} />
            <Button variant="secondary" pending={pressed}>
              Cancel this change
            </Button>
          </>
        )}
      </PostForm>
    </div>
  );
}

/**
 * What a press on the wallet came to that it did not look like, inside the
 * section: a change cancelled by typing the wallet paid now, or a cancel too
 * late, which leads to the pause that stops sales while the old wallet comes
 * back.
 */
function Notice({ notice }: Readonly<{ notice: WalletNoticeView }>) {
  if (notice.kind === "cancelled") {
    return (
      <div className={`${styles.notice} ${styles.done}`}>
        <p className={styles.noticeHead}>Change cancelled</p>
        <p>
          Your share still goes to <Address address={notice.paid} />. Every other session on your
          account was signed out.
        </p>
      </div>
    );
  }
  return (
    <div className={`${styles.notice} ${styles.warn}`}>
      <p className={styles.noticeHead}>Too late to cancel</p>
      <p>
        {notice.at === null ? (
          "Your share now goes to "
        ) : (
          <>
            From <Moment at={notice.at} />, your share goes to{" "}
          </>
        )}
        <Address address={notice.wallet} />.
      </p>
      {notice.askedBack && notice.before !== null ? (
        <p>
          Going back to <Address address={notice.before} /> is a change of its own: it starts in
          forty-eight hours, and everyone on your account was emailed about it.
        </p>
      ) : (
        <p>
          If nobody at your business asked for this, pause all sales now, then set your previous
          wallet
          {notice.before === null ? null : (
            <>
              , <Address address={notice.before} />,
            </>
          )}{" "}
          again below. That change takes forty-eight hours.
        </p>
      )}
      <p>Every other session on your account was signed out.</p>
      <PostForm document action="/cards?selling=pause" className={styles.noticeAction}>
        {(pressed) => <Button pending={pressed}>Pause all sales</Button>}
      </PostForm>
    </div>
  );
}

/** The contract buyers pay into, whole, under the wallet it pays. */
function PaidInto({ split }: Readonly<{ split: SplitView }>) {
  return (
    <>
      <p className={styles.label}>Buyers pay into your payout contract</p>
      <p className={styles.whole}>
        <Address address={split.address} />
        {split.explorer === null ? null : (
          <>
            {" "}
            <a className={styles.balance} href={split.explorer} rel="noreferrer">
              See its balance
            </a>
          </>
        )}
      </p>
    </>
  );
}

/**
 * The box starts empty beside a saved address, because a box you can type over
 * cannot show what is stored; whatever is in it is shown under it in groups,
 * and a refused address with its label, because a box on a phone shows only
 * part of it.
 */
export function PayoutWalletPanel({ wallet }: Readonly<{ wallet: WalletView }>) {
  const { saved, pending, problem, typed } = wallet;
  return (
    <section className={`settings-panel ${styles.section}`} aria-labelledby="payout-wallet">
      {pending === null ? null : <Waiting pending={pending} saved={saved} />}
      {wallet.notice === null ? null : <Notice notice={wallet.notice} />}
      <Head id="payout-wallet" title="Where your money goes">
        <p>
          {wallet.purpose} <a href="/docs/money#getting-paid-out">How payouts work</a>
        </p>
      </Head>
      {saved === null ? null : (
        <div className={styles.current}>
          <p className={styles.label}>Current wallet</p>
          <p className={styles.whole}>
            <Address address={saved} />
          </p>
          {wallet.split === null ? null : <PaidInto split={wallet.split} />}
        </div>
      )}
      {wallet.chain === null ? null : (
        <CoinbaseAddress chainId={wallet.chain} box="payout_wallet" className={styles.coinbase} />
      )}
      <PostForm document action="/settings/payout-wallet" className={`issue ${styles.wallet}`}>
        {(pressed) => (
          <>
            {pending === null ? null : <Shown pending={pending} saved={saved} />}
            <p className={styles.purpose}>
              Paste your wallet's public address. Never enter a private key or recovery phrase.{" "}
              <a href="/docs/money#if-you-have-no-wallet-yet">No wallet yet?</a>
            </p>
            <Field
              label={saved === null ? "Wallet address" : "New wallet address"}
              id="payout_wallet"
              name="payout_wallet"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              maxLength={42}
              defaultValue={typed}
              required
              hint={wallet.rule}
              {...(problem === null ? {} : { error: problem })}
            />
            <WalletEcho box="payout_wallet" initial={typed} className={styles.echo} />
            <Button pending={pressed}>{saved === null ? "Save wallet" : "Change wallet"}</Button>
            <p className={styles.caption}>
              {wallet.commission}
              {wallet.waits === null ? null : ` ${wallet.waits}`}
            </p>
            {pressed && wallet.onItsWay !== null ? (
              <p className={styles.caption} role="status">
                {wallet.onItsWay}
              </p>
            ) : null}
          </>
        )}
      </PostForm>
    </section>
  );
}

/**
 * Copying needs the page's script; where it did not run, or the browser
 * refuses, the data is selected in its box by hand, as the status says.
 */
function CopyData({ data }: Readonly<{ data: string }>) {
  const [said, setSaid] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data);
      setSaid("Copied.");
    } catch {
      setSaid("Could not copy. Select the data in the box above.");
    }
  };
  return (
    <p className="copy-row">
      <Button type="button" variant="secondary" onClick={() => void copy()}>
        Copy the data
      </Button>
      <span role="status">{said}</span>
    </p>
  );
}

/**
 * The transaction for a wallet other than Coinbase's, every value whole, the
 * data included: a transaction pasted from a web page is how wallets are
 * drained, and the merchant can check only what they see in full. Multicall3
 * is named for what it is and as not ours for the same reason.
 */
function AnotherWallet({ payout }: Readonly<{ payout: Extract<PayoutView, { kind: "send" }> }>) {
  return (
    <details className={styles.another}>
      <summary>Send it from another wallet</summary>
      <div className={styles.anotherBody}>
        <p>
          {payout.sentOn} <a href="/docs/payout#with-any-other-wallet">Step by step</a>
        </p>
        <dl className={styles.transaction}>
          <div>
            <dt>To</dt>
            <dd>
              <Address address={payout.to} />
              <span className={styles.quiet}>Multicall3, a public contract, not ours.</span>
            </dd>
          </div>
          <div>
            <dt>ETH to send</dt>
            <dd className={styles.figure}>0</dd>
          </div>
          <div>
            <dt>Data</dt>
            <dd>
              <textarea
                aria-label="Data"
                className={styles.data}
                readOnly
                rows={5}
                spellCheck={false}
                value={payout.data}
              />
              <CopyData data={payout.data} />
            </dd>
          </div>
        </dl>
        <table className={styles.pays}>
          <thead>
            <tr>
              <th scope="col">Payout contract</th>
              <th scope="col">Pays your wallet</th>
            </tr>
          </thead>
          <tbody>
            {payout.pays.map((pair) => (
              <tr key={pair.split}>
                <td data-label="Payout contract">
                  <Address address={pair.split} />
                </td>
                <td data-label="Pays your wallet">
                  <Address address={pair.wallet} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>{payout.after}</p>
      </div>
    </details>
  );
}

function GettingPaid({ payout }: Readonly<{ payout: PayoutView }>) {
  return (
    <section className={`settings-panel ${styles.section}`} aria-labelledby="getting-paid">
      <Head id="getting-paid" title="Getting paid">
        {payout.kind === "send" ? (
          <p>
            Your money waits in your payout contract until someone pays it out. If you don't,
            Agentify's next payout pays it out. It has no fixed date.
          </p>
        ) : (
          <p>{payout.said}</p>
        )}
      </Head>
      {payout.kind !== "send" ? null : (
        <>
          {payout.chain === null ? null : (
            <CoinbasePayout
              chainId={payout.chain}
              payout={{ to: payout.to, data: payout.data }}
              className={styles.coinbase}
            />
          )}
          <AnotherWallet payout={payout} />
        </>
      )}
    </section>
  );
}

/** Its controls end every session of this account, and switch product analytics for the business. */
function Account({ view }: Readonly<{ view: SettingsView }>) {
  const { who, account } = view;
  const off = account.analyticsOptedOut;
  return (
    <section className={`settings-panel ${styles.section}`} aria-labelledby="your-account">
      <Head id="your-account" title="Your account">
        <p>Signed in as {who}.</p>
      </Head>
      <PostForm document action="/settings/sign-out-everywhere" className="issue">
        {(pending) => (
          <>
            <Button variant="secondary" pending={pending}>
              {account.signOutEverywhere}
            </Button>
            <p className={styles.caption}>
              Use this if someone else may have access. Every device signs out, this one included,
              and you sign in again.
            </p>
          </>
        )}
      </PostForm>
      <PostForm document action="/settings/analytics" className="issue">
        {(pending) => (
          <>
            <input type="hidden" name="analytics" value={off ? "on" : "off"} />
            <p className={styles.purpose}>
              {off
                ? "Product analytics are off for your account, and with it for your whole business."
                : "Product analytics are on for your account. Turning them off stops them for your whole business. They never include names, email addresses or wallets."}{" "}
              <a href="/privacy">Privacy policy</a>
            </p>
            <Button variant="secondary" pending={pending}>
              {off ? "Turn product analytics on" : "Turn product analytics off"}
            </Button>
          </>
        )}
      </PostForm>
    </section>
  );
}

/** Four sections, one under another: what buyers see, where the money goes, getting it, the account. */
export function SettingsScreen({ view }: Readonly<{ view: SettingsView }>) {
  return (
    <div className={styles.page}>
      <WhatBuyersSee view={view} />
      <PayoutWalletPanel wallet={view.wallet} />
      {view.payout === null ? null : <GettingPaid payout={view.payout} />}
      <Account view={view} />
    </div>
  );
}
