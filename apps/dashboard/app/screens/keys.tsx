import { Button } from "@agentify/ui";
import { Link } from "react-router";
import type { KeysView, NoCall } from "../../src/keys.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Word } from "../components/word.js";
import { Ident } from "../display/copy.js";
import { Cell, List, Row } from "../display/list.js";
import { CreateKeyForm } from "./create-key.js";
import styles from "./keys.module.css";

/** A row's last call where none is recorded, by which of the two blanks it is. */
const NO_CALL: Readonly<Record<NoCall, string>> = {
  never: "Never used",
  unrecorded: "No call recorded",
};

/**
 * "Revoke", not "Disable", because it does not come back. Two presses: the
 * first, a link, asks for the question through the address, so the server
 * draws it inside the row and a stray tap or a page whose script did not load
 * revokes nothing; the second answers it. A revoked key gets no control at
 * all, since anything there would promise an undo the gateway does not make.
 */
function ConfirmRevoke({ id }: Readonly<{ id: string }>) {
  return (
    <div className={styles.confirm} id="revoke">
      <p>Code that uses this key stops working at once. You can't undo this.</p>
      <PostForm className={styles.revokeForm} action={`/keys/${encodeURIComponent(id)}/disable`}>
        {(pending) => (
          <Button variant="secondary" compact pending={pending}>
            Revoke key
          </Button>
        )}
      </PostForm>
      <Link to="/keys" preventScrollReset className={styles.quietAction}>
        Keep it
      </Link>
    </div>
  );
}

export function KeysScreen({ view }: Readonly<{ view: KeysView }>) {
  const none = view.rows.length === 0;
  return (
    <>
      <div className="lede">
        <div>
          <p>
            {none
              ? "No keys yet. Your code needs a key to connect to Agentify."
              : "Your code connects to Agentify with these keys."}
          </p>
        </div>
      </div>
      {none ? null : (
        <List
          label="API keys"
          columns="minmax(12rem, 1fr) 9rem 9rem minmax(8rem, 11rem) 6rem"
          head={["Name", "Created", "Last call", "State", ""]}
        >
          {view.rows.map((row) => (
            <Row key={row.id} off={row.revoked !== null}>
              <Cell at="main">
                <Cell at="title">{row.label}</Cell>
                <Cell at="ident">
                  <Ident value={row.id} what="key ID" />
                </Cell>
              </Cell>
              <Cell at="aside">
                <Moment at={row.created} />
              </Cell>
              <Cell at="fact">
                {row.lastCall === null ? (
                  NO_CALL[row.noCall ?? "unrecorded"]
                ) : (
                  <>
                    <span className="said-on-narrow">Last call </span>
                    <Moment at={row.lastCall} />
                  </>
                )}
              </Cell>
              <Cell at="state">
                <Word word={row.state} />
                {row.revoked === null ? null : (
                  <span className={styles.when}>
                    {" "}
                    <Moment at={row.revoked} />
                  </span>
                )}
              </Cell>
              {row.revoked !== null || view.confirming === row.id ? null : (
                <Cell at="action">
                  <Link
                    to={`/keys?revoke=${encodeURIComponent(row.id)}#revoke`}
                    preventScrollReset
                    className={styles.quietAction}
                    aria-label={`Revoke ${row.label}`}
                  >
                    Revoke…
                  </Link>
                </Cell>
              )}
              {/* A wide row has a column for this; a narrow one has none. */}
              <div className={`cell cell-note ${styles.created}`}>
                Created <Moment at={row.created} />
              </div>
              {view.confirming === row.id ? <ConfirmRevoke id={row.id} /> : null}
            </Row>
          ))}
        </List>
      )}
      {none ? null : (
        <p className="note">
          A last call can be up to five minutes old.
          {view.unrecorded
            ? ` “${NO_CALL.unrecorded}”: for a key this old we can't tell whether it was ever used.`
            : null}
        </p>
      )}
      <section className={`settings-panel ${styles.newKey}`} aria-labelledby="new-key">
        <div className="lede">
          <div>
            <h2 id="new-key">New key</h2>
            <p>Name it after the code that will use it.</p>
          </div>
        </div>
        <CreateKeyForm view={view} action="/keys" />
      </section>
    </>
  );
}
