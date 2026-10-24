/**
 * Accounts and one account. Accounts lists who made a merchant or holds the
 * operator flag, with their open sessions; the accounts that only signed in
 * are counted under the list and never listed. One account opens to its
 * actions, each a form that asks for a reason and a ticked consequence and
 * draws the fresh sign-in in its place where the sign-in is older than
 * fifteen minutes, and to its history from the journal.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  AccountAct,
  AccountPageView,
  AccountPressed,
  AccountRowView,
  AccountsListView,
  MerchantNamed,
} from "../../../src/admin/accounts.js";
import { LOST_ANSWER } from "../../../src/admin/words.js";
import { ActionForm } from "../../components/admin/action-form.js";
import { StepUp } from "../../components/admin/step-up.js";
import { CouldNotBeRead } from "../../components/admin/unknown.js";
import { ListEmpty } from "../../components/list.js";
import { CutNote, ListTools, NothingHere } from "../../components/listing.js";
import { Moment } from "../../components/moment.js";
import styles from "./accounts.module.css";
import { JournalList, Whole } from "./journal.js";

function Merchant({ merchant }: Readonly<{ merchant: MerchantNamed | null }>) {
  if (merchant === null) return <span className="soft">None</span>;
  return (
    <>
      <Link to={`/admin/merchants/${merchant.id}`}>
        {merchant.name === "could-not-be-read" ? (
          <Whole value={merchant.id} />
        ) : (
          (merchant.name.chosen ?? "Seller name not set")
        )}
      </Link>
      {merchant.name === "could-not-be-read" ? (
        <span className="op-sub">
          Seller name: <CouldNotBeRead />
        </span>
      ) : null}
    </>
  );
}

const Flag = ({ operator }: Readonly<{ operator: boolean }>) =>
  operator ? (
    <span className="badge badge-pass">Operator</span>
  ) : (
    <span className="badge badge-quiet">No</span>
  );

function Row({ row }: Readonly<{ row: AccountRowView }>) {
  return (
    <li className="list-row">
      <div className="cell cell-title">
        <Link to={`/admin/accounts/${row.id}`}>{row.email}</Link>
        {row.you ? <span className="op-sub">You</span> : null}
      </div>
      <div className="cell cell-ident">
        <Merchant merchant={row.merchant} />
      </div>
      <div className="cell cell-state">
        <Flag operator={row.operator} />
      </div>
      <div className="cell cell-fact num">
        {row.openSessions}
        <span className="said-on-narrow">
          {row.openSessions === 1 ? " open session" : " open sessions"}
        </span>
      </div>
      <div className="cell cell-fact">
        {row.newestSession === null ? (
          "None open"
        ) : (
          <>
            <span className="said-on-narrow">newest </span>
            <Moment at={row.newestSession} />
          </>
        )}
      </div>
      <div className="cell cell-action">
        <Link className="button button-secondary button-compact" to={`/admin/accounts/${row.id}`}>
          Actions
        </Link>
      </div>
    </li>
  );
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export function AccountsScreen({ view }: Readonly<{ view: AccountsListView }>) {
  const { listing } = view;
  const none = listing.segments.every((segment) => segment.count === 0) && listing.search.q === "";
  return (
    <>
      <div className="lede">
        <div>
          <p>
            The accounts on this channel that made a merchant or hold the operator flag. Every
            action on an account asks for a fresh sign-in and a reason and is written to the
            journal; granting or removing the operator flag also mails every operator. The flag
            opens this workspace and gives no merchant's account, keys or money.
          </p>
        </div>
      </div>
      <div className={styles.tools}>
        <ListTools
          listing={listing}
          path="/admin/accounts"
          label="Search accounts"
          placeholder="Search by address or merchant"
          searched={(q) =>
            `Only listed accounts whose address or merchant matches “${q}” are counted and shown, and an account that only signed in when “${q}” is its whole address.`
          }
        />
      </div>
      {none ? (
        <ListEmpty>No account on this channel made a merchant or holds the flag.</ListEmpty>
      ) : listing.rows.length === 0 ? (
        <NothingHere listing={listing} />
      ) : (
        <div className="list-box op-cols-accounts">
          <ul className="list" aria-label="Accounts on this channel">
            <li className="list-head" aria-hidden="true">
              <span>Account</span>
              <span>Merchant</span>
              <span>Operator</span>
              <span className="num">Open sessions</span>
              <span>Newest session</span>
              <span />
            </li>
            {listing.rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ul>
        </div>
      )}
      <CutNote cut={listing.cut} />
      <p className="cut">
        <span>
          {view.unlisted === 0
            ? "No account only signed in; every account is one of these. "
            : `${plural(view.unlisted, "more account", "more accounts")} only signed in, most of them to open a scanner's report; they are counted, not listed. `}
          Read <Moment at={view.readAt} />
        </span>
      </p>
      <section className="op-panel" aria-labelledby="first-title">
        <div className="op-panel-head">
          <h2 id="first-title">The first operator</h2>
        </div>
        <div className="op-panel-body">
          <p className="op-sub">
            A channel's first operator comes from its configuration, once: the configured address
            receives the flag at its next sign-in while nobody holds it, the journal says so, and
            the configuration is never read again. The last operator's flag cannot be removed nor
            their account forgotten.
            {view.forgetting
              ? " On this channel each account also offers Forget this account, refused while its merchant has orders or receipts."
              : null}
          </p>
        </div>
      </section>
    </>
  );
}

/** What a press that went through says, over the history that now holds its row. */
const DONE: Readonly<Record<AccountAct, (email: string) => string>> = {
  end_sessions: (email) => `Ended every session of ${email}.`,
  grant_operator: (email) => `Made ${email} an operator; every operator was mailed.`,
  remove_operator: (email) => `Removed the operator flag of ${email}; every operator was mailed.`,
  forget_account: (email) => `Forgot ${email}.`,
};

const UNCHANGED: Readonly<Record<AccountAct, (email: string) => string>> = {
  end_sessions: (email) => `${email} had no session open, so none was ended.`,
  grant_operator: (email) => `${email} is an operator already; nothing changed.`,
  remove_operator: (email) => `${email} is not an operator; nothing changed.`,
  forget_account: (email) => `${email} was forgotten already.`,
};

function Settled({ pressed, email }: Readonly<{ pressed: AccountPressed | null; email: string }>) {
  if (pressed === null) return null;
  const { answer, act } = pressed;
  if (answer.kind !== "done" && answer.kind !== "unchanged") return null;
  return (
    <p className="op-bound" role="status">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
      <span>{(answer.kind === "done" ? DONE : UNCHANGED)[act](email)} Written to the journal.</span>
    </p>
  );
}

const answerFor = (pressed: AccountPressed | null, act: AccountAct) =>
  pressed?.act === act ? pressed.answer : null;

/**
 * A press whose form this page no longer draws, such as removing the flag of
 * an account that holds none, or any press on an account that is gone: its
 * step-up, refusal or lost answer is drawn here instead.
 */
function PressedElsewhere({ pressed }: Readonly<{ pressed: AccountPressed | null }>) {
  const answer = pressed?.answer;
  if (answer === undefined) return null;
  if (answer.kind === "step-up") {
    return (
      <div className="op-decide">
        <StepUp view={answer.stepUp} />
      </div>
    );
  }
  if (answer.kind === "refused") {
    return (
      <p className="problem" role="alert">
        {answer.said}
      </p>
    );
  }
  if (answer.kind === "unknown") {
    return (
      <p className="problem" role="alert">
        {LOST_ANSWER}
      </p>
    );
  }
  return null;
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function AccountScreen({ view }: Readonly<{ view: AccountPageView }>) {
  if (view.kind === "absent") {
    const forgotten = view.pressed?.act === "forget_account" && view.pressed.answer.kind === "done";
    return (
      <>
        {forgotten ? (
          <p className="op-bound" role="status">
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
            <span>
              The account was forgotten, with its merchant where it had one; the address signs in
              again as a newcomer. Written to the journal, which names it as a deleted account.
            </span>
          </p>
        ) : (
          <PressedElsewhere pressed={view.pressed} />
        )}
        <ListEmpty>
          No account on this channel has the identifier <Whole value={view.id} />. The journal names
          a forgotten or erased account as a deleted account.
        </ListEmpty>
        <p className="op-sub">
          <Link to="/admin/accounts">All accounts</Link>
        </p>
      </>
    );
  }
  const { account, pressed } = view;
  const path = `/admin/accounts/${account.id}`;
  const drawn: readonly AccountAct[] = [
    "end_sessions",
    account.operator ? (view.lastOperator ? null : "remove_operator") : "grant_operator",
    view.forget.kind === "allowed" ? "forget_account" : null,
  ].filter((act): act is AccountAct => act !== null);
  const yours = account.you ? " That includes the session you are using." : "";
  return (
    <>
      <p className="op-facts-line">
        {account.you ? <span>Your own account</span> : null}
        {account.operator ? (
          <span className="badge badge-pass">Operator</span>
        ) : (
          <span className="badge badge-quiet">Not an operator</span>
        )}
        <span>
          Read <Moment at={view.readAt} />
        </span>
      </p>
      <Settled pressed={pressed} email={account.email} />
      {pressed === null || drawn.includes(pressed.act) ? null : (
        <PressedElsewhere pressed={pressed} />
      )}
      <div className="op-two">
        <section className="op-panel" aria-labelledby="facts-title">
          <div className="op-panel-head">
            <h2 id="facts-title">The account</h2>
          </div>
          <div className="op-panel-body">
            <dl className="op-kv">
              <Fact label="Account">
                <Whole value={account.id} />
              </Fact>
              <Fact label="Made">
                <Moment at={account.createdAt} />
              </Fact>
              <Fact label="Merchant">
                <Merchant merchant={account.merchant} />
              </Fact>
              <Fact label="Open sessions">{account.openSessions}</Fact>
              <Fact label="Newest session">
                {account.newestSession === null ? (
                  "None open"
                ) : (
                  <Moment at={account.newestSession} />
                )}
              </Fact>
            </dl>
          </div>
        </section>
        <section className="op-panel" aria-labelledby="acts-title">
          <div className="op-panel-head">
            <h2 id="acts-title">Actions</h2>
            <p>Each asks for a fresh sign-in and a reason, and is written to the journal.</p>
          </div>
          <div className="op-panel-body">
            <ActionForm
              action={`${path}/end-sessions`}
              title="End every session"
              button="End every session"
              consequence={`Sign ${account.email} out everywhere now. The account stays; they sign in again with a new link.${yours}`}
              reason
              answer={answerFor(pressed, "end_sessions")}
              secondary
            />
            {account.operator ? (
              view.lastOperator ? (
                <p className="op-sub">
                  The last operator's flag cannot be removed, so the channel cannot lock its
                  operators out.
                </p>
              ) : (
                <ActionForm
                  action={`${path}/remove-operator`}
                  title="Remove the operator flag"
                  button="Remove the flag"
                  consequence={`Close this workspace to ${account.email} at their next request. Every operator of the channel and ${account.email} are mailed about it first.`}
                  reason
                  answer={answerFor(pressed, "remove_operator")}
                  secondary
                />
              )
            ) : (
              <ActionForm
                action={`${path}/grant-operator`}
                title="Make an operator"
                button="Make an operator"
                consequence={`Give ${account.email} this workspace: every merchant, order and account of the channel, and its actions. Every operator of the channel and ${account.email} are mailed about it first.`}
                reason
                answer={answerFor(pressed, "grant_operator")}
                secondary
              />
            )}
            <Forget view={view} path={path} />
          </div>
        </section>
      </div>
      <section className="op-panel" aria-labelledby="history-title">
        <div className="op-panel-head">
          <h2 id="history-title">History</h2>
          <p>What the journal holds about this account, newest first.</p>
        </div>
        <div className="op-panel-body">
          {view.history === "could-not-be-read" ? (
            <p>
              The journal: <CouldNotBeRead />
            </p>
          ) : view.history.lines.length === 0 ? (
            <p className="op-sub">No administrative action about this account yet.</p>
          ) : (
            <>
              <JournalList lines={view.history.lines} label="This account's history" />
              {view.history.total > view.history.lines.length ? (
                <p className="cut">
                  <span>{`${view.history.lines.length} of ${view.history.total} shown. `}</span>
                  <Link to={`/admin/journal?q=${encodeURIComponent(account.id)}`}>
                    All of them in the journal
                  </Link>
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>
    </>
  );
}

function Forget({
  view,
  path,
}: Readonly<{ view: Extract<AccountPageView, { kind: "found" }>; path: string }>) {
  const { forget, account } = view;
  switch (forget.kind) {
    case "live-channel":
      return null;
    case "operator":
      return (
        <p className="op-sub">An operator's account cannot be forgotten: remove the flag first.</p>
      );
    case "money-history":
      return (
        <p className="op-sub">
          {`This account's merchant has ${plural(forget.history.orders, "order", "orders")} and ${plural(forget.history.receipts, "receipt", "receipts")}, which are never deleted, so the account cannot be forgotten.`}
        </p>
      );
    case "could-not-be-read":
      return (
        <p className="op-sub">
          Whether its merchant has orders or receipts: <CouldNotBeRead />. It cannot be forgotten
          until that is read.
        </p>
      );
    case "allowed":
      return (
        <ActionForm
          action={`${path}/forget`}
          title="Forget this account"
          button="Forget this account"
          consequence={`Remove ${account.email}${account.merchant === null ? "" : " and its merchant, with the merchant's keys and cards,"} from this channel, so the address signs in again as a newcomer. The journal keeps its rows.`}
          reason
          answer={answerFor(view.pressed, "forget_account")}
          secondary
        />
      );
  }
}
