/**
 * The Journal: every administrative action on the channel, newest first, with
 * who acted, what was done to which record, the reason written, where it came
 * from and its outcome. Its rows are drawn here for an account's history too.
 * People are named by their address while their account exists, as a deleted
 * account after, and by identifier where the addresses could not be read; a
 * merchant by the seller name it chose, or by its
 * identifier where it chose none.
 */

import type { ReactNode } from "react";
import { Form, Link } from "react-router";
import type { JournalLineView, JournalView } from "../../../src/admin/accounts.js";
import { COULD_NOT_BE_READ } from "../../../src/admin/words.js";
import { shortened } from "../../components/copy.js";
import { ListEmpty } from "../../components/list.js";
import { Pager } from "../../components/listing.js";
import { Moment } from "../../components/moment.js";
import styles from "./accounts.module.css";

/** An identifier shown short, opening to its whole value, ready to select. */
export function Whole({ value }: Readonly<{ value: string }>) {
  const short = shortened(value);
  return short === value ? (
    <span className="mono">{value}</span>
  ) : (
    <details className="ident-whole">
      <summary title={value}>{short}</summary>
      <span className="ident-all">{value}</span>
    </details>
  );
}

const accountNamed = (id: string, email: string | null, addressesRead: boolean): ReactNode =>
  !addressesRead ? (
    <>
      the account <Whole value={id} />
    </>
  ) : email === null ? (
    <>
      a deleted account <Whole value={id} />
    </>
  ) : (
    <Link to={`/admin/accounts/${id}`}>{email}</Link>
  );

const merchantNamed = (id: string, name: string | null): ReactNode => (
  <Link to={`/admin/merchants/${id}`}>{name ?? <Whole value={id} />}</Link>
);

/**
 * What a row records, its subject linked to the record: what was done, or,
 * for a press that changed nothing, what was asked. On the merchant's own
 * page the merchant is left out, since every row there is about them.
 */
function What({ line, onItsPage }: Readonly<{ line: JournalLineView; onItsPage: boolean }>) {
  const { subject } = line;
  const merchant =
    subject.merchantId === null || onItsPage
      ? null
      : merchantNamed(subject.merchantId, subject.label);
  const account =
    subject.kind === "account" ? accountNamed(subject.id, subject.label, line.addressesRead) : null;
  const done = line.outcome.kind === "done";
  switch (line.action) {
    case "admit":
      return done ? (
        <>Admitted {merchant === null ? null : <>{merchant} </>}to live sales</>
      ) : (
        <>Asked to admit {merchant === null ? null : <>{merchant} </>}to live sales</>
      );
    case "withdraw":
      return done ? (
        <>Withdrew the admission{merchant === null ? null : <> of {merchant}</>}</>
      ) : (
        <>Asked to withdraw the admission{merchant === null ? null : <> of {merchant}</>}</>
      );
    case "disable_key":
      return (
        <>
          {done ? "Disabled" : "Asked to disable"} the key <Whole value={subject.id} />
          {merchant === null ? null : <> of {merchant}</>}
        </>
      );
    case "end_sessions":
      return done ? (
        <>Ended every session of {account}</>
      ) : (
        <>Asked to end every session of {account}</>
      );
    case "grant_operator":
      return done ? <>Made {account} an operator</> : <>Asked to make {account} an operator</>;
    case "remove_operator":
      return done ? (
        <>Removed the operator flag of {account}</>
      ) : (
        <>Asked to remove the operator flag of {account}</>
      );
    case "forget_account":
      return done ? (
        <>
          Forgot the account <Whole value={subject.id} />
          {subject.label === null ? null : <> of {subject.label}</>}
        </>
      ) : (
        <>Asked to forget {account}</>
      );
    case "first_operator":
      return <>Gave {account} the flag as the channel's first operator</>;
  }
}

const WHERE: Readonly<Record<JournalLineView["actor"]["kind"], string>> = {
  account: "Workspace",
  terminal: "Terminal",
  configuration: "Configuration",
};

function Who({ line: { actor, addressesRead } }: Readonly<{ line: JournalLineView }>) {
  if (actor.kind === "terminal") return <>The terminal</>;
  if (actor.kind === "configuration") return <>The configuration</>;
  return <>{accountNamed(actor.id, actor.email, addressesRead)}</>;
}

function Outcome({ line }: Readonly<{ line: JournalLineView }>) {
  switch (line.outcome.kind) {
    case "done":
      return <span className="badge badge-pass">Done</span>;
    case "unchanged":
      return <span className="badge badge-quiet">Unchanged</span>;
    case "refused":
      return <span className="badge badge-quiet">Refused</span>;
  }
}

/**
 * Rows of the journal as a list, with what each says under it; `onItsPage`
 * leaves out the merchant a merchant's own page stands on.
 */
export function JournalList({
  lines,
  label,
  onItsPage = false,
}: Readonly<{ lines: readonly JournalLineView[]; label: string; onItsPage?: boolean }>) {
  return (
    <div className="list-box op-cols-journal">
      <ul className="list" aria-label={label}>
        <li className="list-head" aria-hidden="true">
          <span>When</span>
          <span>Who</span>
          <span>What</span>
          <span>From</span>
          <span>Outcome</span>
        </li>
        {lines.map((line) => (
          <li className="list-row" key={line.sequence}>
            <div className="cell cell-fact">
              <Moment at={line.at} />
            </div>
            <div className="cell cell-ident">
              <Who line={line} />
            </div>
            <div className="cell cell-title">
              <What line={line} onItsPage={onItsPage} />
              {line.reason === null ? null : <span className="op-sub">Reason: {line.reason}</span>}
              {line.refusal === null ? null : (
                <span className="op-sub">Refused: {line.refusal}</span>
              )}
            </div>
            <div className="cell cell-fact">
              <span className="said-on-narrow">From </span>
              {WHERE[line.actor.kind]}
            </div>
            <div className="cell cell-state">
              <Outcome line={line} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const KIND_LABELS: Readonly<Record<JournalView["kind"], string>> = {
  all: "All",
  admission: "Admission",
  keys: "Keys",
  sessions: "Sessions",
  flag: "Operator flag",
  forgotten: "Forgotten accounts",
};

const addressOf = (kind: JournalView["kind"], q: string, before: number | null): string => {
  const query = new URLSearchParams();
  if (kind !== "all") query.set("kind", kind);
  if (q !== "") query.set("q", q);
  if (before !== null) query.set("before", String(before));
  const search = query.toString();
  return search === "" ? "/admin/journal" : `/admin/journal?${search}`;
};

const UNSEARCHED: Readonly<Record<NonNullable<JournalView["unsearched"]>, string>> = {
  "no-such-account":
    "No account on this channel has that email address now. A forgotten account is searched by its ID, which its rows keep.",
  "not-searchable":
    "The journal is searched by a merchant ID (mch_…), an account's email address or an account ID. Reasons are not searched.",
};

export function JournalScreen({ view }: Readonly<{ view: JournalView }>) {
  return (
    <>
      <div className={`list-tools ${styles.tools}`}>
        <Form method="get" action="/admin/journal" role="search" className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            name="q"
            aria-label="Search the journal"
            placeholder="Merchant ID, account email or ID"
            defaultValue={view.query}
          />
          {view.kind === "all" ? null : <input type="hidden" name="kind" value={view.kind} />}
        </Form>
        <nav className="segments" aria-label="Kind of action">
          {view.kinds.map((one) => {
            const words = (
              <>
                {KIND_LABELS[one.kind]}{" "}
                {view.unsearched !== null ? null : one.count === null ? (
                  <span className="badge badge-unknown" title={COULD_NOT_BE_READ}>
                    <span className="sr-only">{COULD_NOT_BE_READ}</span>
                  </span>
                ) : (
                  <b>{one.count}</b>
                )}
              </>
            );
            return one.kind === view.kind ? (
              <span key={one.kind} className="here" aria-current="page">
                {words}
              </span>
            ) : (
              <Link key={one.kind} to={addressOf(one.kind, view.query, null)}>
                {words}
              </Link>
            );
          })}
        </nav>
      </div>
      {view.unsearched !== null ? (
        <ListEmpty>
          {UNSEARCHED[view.unsearched]}{" "}
          <Link to={addressOf(view.kind, "", null)}>Clear the search</Link>
        </ListEmpty>
      ) : view.lines.length === 0 ? (
        <ListEmpty>
          {view.before !== null
            ? "No older rows."
            : view.query !== "" || view.kind !== "all"
              ? view.query === ""
                ? "No action of this kind on this channel."
                : view.searchedAs === "merchant"
                  ? `No row is about the merchant ${view.query}.`
                  : view.searchedAs === "address"
                    ? `No row is about the account at ${view.query}.`
                    : `No row is about an account with the ID “${view.query}”.`
              : "No administrative action on this channel yet."}
        </ListEmpty>
      ) : (
        <JournalList lines={view.lines} label="Administrative actions" />
      )}
      {view.unsearched !== null ? null : (
        <Pager
          range={
            <>
              {`${view.lines.length} of ${view.total} shown, newest first${
                view.before === null ? "" : ", older than the page before"
              } · read `}
              <Moment at={view.readAt} />
            </>
          }
          previous={{
            to: view.before === null ? null : addressOf(view.kind, view.query, null),
            words: "Newest",
            beside: false,
          }}
          next={{
            to: view.next === null ? null : addressOf(view.kind, view.query, view.next),
            words: "Older",
          }}
        />
      )}
    </>
  );
}
