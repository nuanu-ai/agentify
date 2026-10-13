import { Button, Field } from "@agentify/ui";
import { Form } from "react-router";
import type { SettingsView, WalletView } from "../../src/settings-view.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";

/**
 * An address whole, never with the middle elided: first-few, dots, last-few is
 * the one presentation under which a wrong address and the right one look
 * identical. In groups of four as spans with nothing between them, so the gaps
 * are the stylesheet's and a copied address pastes as an address.
 */
function Address({ address }: Readonly<{ address: string }>) {
  return (
    <>
      <span className="lead">{address.slice(0, 2)}</span>
      {(address.slice(2).match(/.{1,4}/g) ?? []).map((group, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the groups of one address never reorder
        <span className="quad" key={at}>
          {group}
        </span>
      ))}
    </>
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

function NameAndSite({ view }: Readonly<{ view: SettingsView }>) {
  const { name, site } = view;
  return (
    <>
      <div className="panel-top">
        <div className="lede">
          <div>
            <h2>Seller name</h2>
            <p className="quiet">{name.rule}</p>
            {name.standing === null ? null : <p className="quiet">{name.standing}</p>}
          </div>
        </div>
      </div>
      <PostForm document action="/settings" className="issue">
        {(pending) => (
          <>
            <Field
              label="Your seller name"
              id="seller_name"
              name="seller_name"
              type="text"
              autoComplete="organization"
              maxLength={32}
              defaultValue={name.value}
              required
              {...(name.problem === null ? {} : { error: name.problem })}
            />
            <Button pending={pending}>Save</Button>
          </>
        )}
      </PostForm>
      <div className="panel-messages">
        <div className="panel-follow">
          <h2>Your shop's site</h2>
          <p className="quiet">{site.rule}</p>
          <PostForm document action="/settings/site" className="issue">
            {(pending) => (
              <>
                <Field
                  label="Your shop's site"
                  id="seller_site"
                  name="seller_site"
                  type="url"
                  autoComplete="url"
                  inputMode="url"
                  placeholder="https://yourshop.com"
                  defaultValue={site.value}
                  required
                  {...(site.problem === null ? {} : { error: site.problem })}
                />
                <Button pending={pending}>Save</Button>
              </>
            )}
          </PostForm>
        </div>
      </div>
    </>
  );
}

/**
 * The change waiting is always shown, because the message announcing it says
 * it takes effect only if this screen shows it. The box starts empty beside a
 * saved address, because a box you can type over cannot show what is stored;
 * a refused address is shown whole under its refusal, because a box on a phone
 * shows only part of it.
 */
export function PayoutWalletPanel({ wallet }: Readonly<{ wallet: WalletView }>) {
  const { saved, pending, problem, typed } = wallet;
  return (
    <>
      <div className="panel-top">
        <div className="lede">
          <div>
            <h2>Payout wallet</h2>
            <p>
              {wallet.purpose}{" "}
              <a href="/docs/money#where-the-money-arrives">How and when you get paid</a>.
            </p>
            <p className="quiet">
              Enter only the public address. Never enter a private key or recovery phrase; Agentify
              will never ask for either.{" "}
              <a href="/docs/money#if-you-have-no-wallet-yet">No wallet yet?</a>
            </p>
          </div>
        </div>
        {saved === null ? null : (
          <div className="saved">
            <div className="label">Saved here</div>
            <div className="address">
              <Address address={saved} />
            </div>
            <p className="under">
              The full address, spelled the way your wallet shows it. Check it against your wallet,
              one group of characters at a time.
            </p>
          </div>
        )}
        {pending === null ? null : (
          <div className="saved">
            <div className="label">Waiting to replace it</div>
            <div className="address">
              <Address address={pending.wallet} />
            </div>
            <p className="under">
              From <Moment at={pending.from} /> your sales are paid into this address instead. Every
              account of your merchant was sent a message about it. If nobody at your business asked
              for it, cancel it; cancelling also signs out every session of your merchant but this
              one.
            </p>
            <PostForm document action="/settings/payout-wallet/cancel" className="inline">
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
        )}
        {wallet.notice === null ? null : <p className="problem">{wallet.notice}</p>}
        <div className="lede">
          <div>
            <p className="quiet">{wallet.rule}</p>
            {wallet.waits === null ? null : <p className="quiet">{wallet.waits}</p>}
          </div>
        </div>
      </div>
      <PostForm document action="/settings/payout-wallet" className="issue">
        {(pressed) => (
          <>
            {pending === null ? null : <Shown pending={pending} saved={saved} />}
            <Field
              label={saved === null ? "Payout wallet address" : "New payout wallet address"}
              id="payout_wallet"
              name="payout_wallet"
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={42}
              size={42}
              defaultValue={typed}
              required
              {...(problem === null ? {} : { error: problem })}
            />
            <Button pending={pressed}>{saved === null ? "Save" : "Change the address"}</Button>
            {pressed && wallet.onItsWay !== null ? <p role="status">{wallet.onItsWay}</p> : null}
          </>
        )}
      </PostForm>
      <div className="panel-messages">
        {problem === null || typed === "" ? null : (
          <p className="address">
            <Address address={typed} />
          </p>
        )}
      </div>
    </>
  );
}

/** Its one control ends every other session of this account and keeps this one. */
function Account({ view }: Readonly<{ view: SettingsView }>) {
  const { who, account } = view;
  return (
    <>
      <div className="lede">
        <div>
          <h2>The account you sign in with</h2>
          <p>
            You sign in as {who}. A one-time link sent to this address is how you get back into your
            dashboard.
          </p>
          <p className="quiet">There is no way to change the address itself yet.</p>
        </div>
        <Form className="inline" method="post" action="/sign-out" reloadDocument>
          <Button variant="secondary">Sign out</Button>
        </Form>
      </div>
      <PostForm document action="/settings/sign-out-others" className="issue">
        {(pending) => (
          <>
            <p className="quiet">
              Ends every session of {who} except this one, on any device. Each of them needs a new
              link to sign in again.
            </p>
            <Button variant="secondary" pending={pending}>
              {account.signOutOthers}
            </Button>
            {account.notice === null ? null : <p role="status">{account.notice}</p>}
          </>
        )}
      </PostForm>
    </>
  );
}

export function SettingsScreen({ view }: Readonly<{ view: SettingsView }>) {
  return (
    <>
      <div className="lede">
        <div>
          <p>{view.lede}</p>
          {view.approval === null ? null : <p>{view.approval}</p>}
        </div>
      </div>
      <div className="settings-grid">
        <section className="settings-panel settings-pair">
          <NameAndSite view={view} />
        </section>
        <section className="settings-panel settings-pair">
          <PayoutWalletPanel wallet={view.wallet} />
        </section>
        <section className="settings-panel settings-wide settings-account">
          <Account view={view} />
        </section>
      </div>
    </>
  );
}
