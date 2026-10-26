/**
 * Accounts and one account. Accounts lists who made a merchant or holds the
 * operator flag, with their open sessions; the accounts that only signed in
 * are counted under the list and never listed. One account opens to its
 * actions, each closed until it is wanted and opened in place, the one that
 * cannot be undone last and apart, and to its history from the journal.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  AccountAct,
  AccountPageView,
  AccountRowView,
  AccountsListView,
  MerchantNamed,
} from "../../../src/admin/accounts.js";
import type { ActionAnswer } from "../../../src/admin/action.js";
import { IN_THE_JOURNAL } from "../../../src/admin/words.js";
import { ActionForm, InPlace, opensOn } from "../../components/admin/action-form.js";
import { PressAnswer } from "../../components/admin/press-answer.js";
import { CouldNotBeRead } from "../../components/admin/unknown.js";
import { ListEmpty } from "../../components/list.js";
import { CutNote, ListTools, NothingHere } from "../../components/listing.js";
import { Moment } from "../../components/moment.js";
import styles from "./accounts.module.css";
import { JournalList, Whole } from "./journal.js";

/** A merchant an account names, by its seller name, or what it is known by without one. */
const merchantWords = (merchant: MerchantNamed): ReactNode =>
  merchant.name === "could-not-be-read" ? (
    <Whole value={merchant.id} />
  ) : (
    (merchant.name.chosen ?? "No seller name")
  );

function Merchant({ merchant }: Readonly<{ merchant: MerchantNamed | null }>) {
  if (merchant === null) return <span className="soft">No merchant</span>;
  return (
    <>
      <Link to={`/admin/merchants/${merchant.id}`}>{merchantWords(merchant)}</Link>
      {merchant.name === "could-not-be-read" ? (
        <span className="op-sub">
          Seller name: <CouldNotBeRead />
        </span>
      ) : null}
    </>
  );
}

function Row({ row }: Readonly<{ row: AccountRowView }>) {
  return (
    <li className="list-row">
      <div className="cell cell-title">
        <Link to={`/admin/accounts/${row.id}`}>{row.email}</Link>
        {row.operator || row.you ? (
          <span className="op-sub">
            {row.operator ? <span className="badge badge-pass">Operator</span> : null}
            {row.you ? <span>You</span> : null}
          </span>
        ) : null}
      </div>
      <div className="cell cell-ident">
        <Merchant merchant={row.merchant} />
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
          <p>Accounts that made a merchant or hold the operator flag.</p>
        </div>
      </div>
      <div className={styles.tools}>
        <ListTools
          listing={listing}
          path="/admin/accounts"
          label="Search accounts"
          placeholder="Email or merchant"
          searched={(q) =>
            `Listed accounts matching “${q}”. An account that only signed in is found by its whole email address.`
          }
        />
      </div>
      {none ? (
        <ListEmpty>No account here made a merchant or holds the flag.</ListEmpty>
      ) : listing.rows.length === 0 ? (
        <NothingHere listing={listing} />
      ) : (
        <div className="list-box op-cols-accounts">
          <ul className="list" aria-label="Accounts">
            <li className="list-head" aria-hidden="true">
              <span>Account</span>
              <span>Merchant</span>
              <span className="num">Open sessions</span>
              <span>Newest session</span>
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
            ? "Every account here made a merchant or holds the flag."
            : `${plural(view.unlisted, "more account", "more accounts")} only signed in. Search by the whole email address to find one.`}
        </span>
        <span>
          Read <Moment at={view.readAt} />
        </span>
      </p>
    </>
  );
}

const answerFor = (
  pressed: Extract<AccountPageView, { kind: "found" }>["pressed"],
  ...acts: readonly AccountAct[]
): ActionAnswer | null => (pressed !== null && acts.includes(pressed.act) ? pressed.answer : null);

/**
 * The answer to an action's press beside its place on the page: always where
 * the form is not drawn, and where it is, only once it went through, since
 * the open form says the rest under its own button.
 */
function Settled({
  answer,
  formDrawn,
  done,
  unchanged,
  page,
}: Readonly<{
  answer: ActionAnswer | null;
  formDrawn: boolean;
  done: string;
  unchanged: string;
  page: string;
}>) {
  if (answer === null) return null;
  if (formDrawn && answer.kind !== "done" && answer.kind !== "unchanged") return null;
  return <PressAnswer answer={answer} done={done} unchanged={unchanged} page={page} />;
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const Tick = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/** The page of an account that is not there: forgotten by the press just made, or never here. */
function Absent({ view }: Readonly<{ view: Extract<AccountPageView, { kind: "absent" }> }>) {
  const forgotten = view.pressed?.act === "forget_account" && view.pressed.answer.kind === "done";
  if (forgotten) {
    return (
      <div className="message-panel" role="status">
        <p className="op-answer op-answer-done">
          <Tick />
          <span>
            Deleted, with its merchant where it had one. The address can sign in again as a
            newcomer. {IN_THE_JOURNAL}
          </span>
        </p>
        <Link className="button button-secondary" to="/admin/accounts">
          All accounts
        </Link>
      </div>
    );
  }
  const path = `/admin/accounts/${view.id}`;
  return (
    <div className="message-panel">
      {view.pressed === null ? null : (
        <PressAnswer answer={view.pressed.answer} done="Done." page={path} />
      )}
      <p>
        No account here has the ID <Whole value={view.id} />. It may have been deleted.
      </p>
      <Link className="button button-secondary" to="/admin/accounts">
        All accounts
      </Link>
    </div>
  );
}

/** What a press on an account did, said where the account cannot be named. */
const PRESS_DONE: Readonly<Record<AccountAct, string>> = {
  end_sessions: "Every session ended.",
  grant_operator: "Made an operator; every operator was mailed.",
  remove_operator: "Operator flag removed; every operator was mailed.",
  forget_account: "Account forgotten.",
};

/** A press answered without its page, which could not be read again after it. */
function PressedUnread({
  view,
}: Readonly<{ view: Extract<AccountPageView, { kind: "pressed-unread" }> }>) {
  const path = `/admin/accounts/${view.id}`;
  return (
    <div className="message-panel" role="status">
      <PressAnswer answer={view.pressed.answer} done={PRESS_DONE[view.pressed.act]} page={path} />
      <p>The account's page could not be read again after the press.</p>
      <Link className="button button-primary" to={path}>
        Open the account's page
      </Link>
    </div>
  );
}

export function AccountScreen({ view }: Readonly<{ view: AccountPageView }>) {
  if (view.kind === "absent") return <Absent view={view} />;
  if (view.kind === "pressed-unread") return <PressedUnread view={view} />;
  const { account, pressed, stepUp } = view;
  const path = `/admin/accounts/${account.id}`;
  const sessions = answerFor(pressed, "end_sessions");
  const flag = answerFor(pressed, "grant_operator", "remove_operator");
  const yours = account.you ? " This includes your own session." : "";
  const merchantNamed =
    account.merchant === null
      ? null
      : account.merchant.name !== "could-not-be-read" && account.merchant.name.chosen !== null
        ? account.merchant.name.chosen
        : "its merchant";
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
      <div className="op-two">
        <section className="op-panel" aria-labelledby="facts-title">
          <div className="op-panel-head">
            <h2 id="facts-title">The account</h2>
          </div>
          <div className="op-panel-body">
            <dl className="op-kv">
              <Fact label="Account ID">
                <span className="ident">
                  <Whole value={account.id} />
                </span>
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
          </div>
          <div className="op-panel-body op-acts">
            <div className="op-act-slot">
              {account.openSessions === 0 ? (
                <p className="op-sub">No open sessions to end.</p>
              ) : (
                <InPlace summary="End every session…" open={opensOn(sessions)}>
                  <ActionForm
                    action={`${path}/end-sessions`}
                    page={path}
                    button="End every session"
                    consequence={`Sign ${account.email} out everywhere now. They sign in again with a new link.${yours}`}
                    reason
                    answer={sessions}
                    stepUp={stepUp}
                  />
                </InPlace>
              )}
              <Settled
                answer={sessions}
                formDrawn={account.openSessions > 0}
                done={`Ended every session of ${account.email}.`}
                unchanged={`${account.email} had no session open, so none was ended.`}
                page={path}
              />
            </div>
            <div className="op-act-slot">
              {account.operator ? (
                view.lastOperator ? (
                  <p className="op-sub">You are the last operator, so the flag stays.</p>
                ) : (
                  <InPlace summary="Remove the operator flag…" open={opensOn(flag)}>
                    <ActionForm
                      action={`${path}/remove-operator`}
                      page={path}
                      button="Remove the flag"
                      consequence={`Close this workspace to ${account.email}. Every operator and ${account.email} get an email about it first.`}
                      reason
                      answer={pressed?.act === "remove_operator" ? flag : null}
                      stepUp={stepUp}
                    />
                  </InPlace>
                )
              ) : (
                <InPlace summary="Make an operator…" open={opensOn(flag)}>
                  <ActionForm
                    action={`${path}/grant-operator`}
                    page={path}
                    button="Make an operator"
                    consequence={`Give ${account.email} this workspace: every merchant, order and account here, and its actions. Every operator and ${account.email} get an email about it first.`}
                    reason
                    answer={pressed?.act === "grant_operator" ? flag : null}
                    stepUp={stepUp}
                  />
                </InPlace>
              )}
              <Settled
                answer={flag}
                formDrawn={
                  (account.operator
                    ? !view.lastOperator && pressed?.act === "remove_operator"
                    : pressed?.act === "grant_operator") === true
                }
                done={
                  pressed?.act === "grant_operator"
                    ? `Made ${account.email} an operator; every operator was mailed.`
                    : `Removed the operator flag of ${account.email}; every operator was mailed.`
                }
                unchanged={
                  pressed?.act === "grant_operator"
                    ? `${account.email} is an operator already; nothing changed.`
                    : `${account.email} is not an operator; nothing changed.`
                }
                page={path}
              />
            </div>
            <Forget view={view} path={path} merchantNamed={merchantNamed} />
          </div>
        </section>
      </div>
      <section className="op-panel" aria-labelledby="history-title">
        <div className="op-panel-head">
          <h2 id="history-title">History</h2>
          <p>From the journal</p>
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
                  <span>{`The newest ${view.history.lines.length} of ${view.history.total} rows.`}</span>
                  <Link to={`/admin/journal?q=${encodeURIComponent(account.id)}`}>
                    All {view.history.total} in the journal
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
  merchantNamed,
}: Readonly<{
  view: Extract<AccountPageView, { kind: "found" }>;
  path: string;
  merchantNamed: string | null;
}>) {
  const { forget, account } = view;
  const answer = answerFor(view.pressed, "forget_account");
  const standing = (said: ReactNode) => (
    <div className="op-act-slot op-act-apart">
      <p className="op-sub">{said}</p>
      <PressAnswer answer={answer} done="Done." page={path} />
    </div>
  );
  switch (forget.kind) {
    case "live-channel":
      return null;
    case "operator":
      return standing("An operator's account cannot be forgotten: remove the flag first.");
    case "money-history":
      return standing(
        `This account's merchant has ${plural(forget.history.orders, "order", "orders")} and ${plural(forget.history.receipts, "receipt", "receipts")}, which are never deleted, so the account cannot be forgotten.`,
      );
    case "could-not-be-read":
      return standing(
        <>
          Whether its merchant has orders or receipts: <CouldNotBeRead />. It cannot be forgotten
          until that is read.
        </>,
      );
    case "allowed":
      return (
        <div className="op-act-slot op-act-apart">
          <InPlace summary="Forget this account…" tone="destructive" open={opensOn(answer)}>
            <ActionForm
              action={`${path}/forget`}
              page={path}
              button="Forget this account"
              consequence={`Delete ${account.email}${merchantNamed === null ? "" : ` and ${merchantNamed}, with its keys and products`}. This cannot be undone. The journal keeps its rows.`}
              reason
              answer={answer}
              tone="destructive"
              stepUp={view.stepUp}
            />
          </InPlace>
        </div>
      );
  }
}
