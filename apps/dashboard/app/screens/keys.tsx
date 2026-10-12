import { Button, Table } from "@agentify/ui";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router";
import type { KeysView, NewKeyView } from "../../src/keys.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";

/**
 * Named once because the note under the table quotes it, and that note is the
 * only thing explaining what the blank covers.
 */
const NO_CALLS_RECORDED = "No calls recorded";

/**
 * "Revoke", not "Disable", because it does not come back. Two presses, the
 * first only opening the second: a details element does that without a script,
 * so a stray tap or a page whose script did not load cannot revoke anything. A
 * revoked key gets no control at all, since anything there would promise an
 * undo the gateway does not make.
 */
const Revoke = ({ id }: Readonly<{ id: string }>) => (
  <details className="confirm-revoke">
    <summary className="confirm-open button button-compact button-secondary">Revoke</summary>
    <div className="confirm-pop">
      <p>This key will stop working for good.</p>
      <PostForm className="inline" action={`/keys/${encodeURIComponent(id)}/disable`}>
        {(pending) => (
          <Button compact pending={pending}>
            Yes, revoke
          </Button>
        )}
      </PostForm>
    </div>
  </details>
);

export function KeysScreen({ view }: Readonly<{ view: KeysView }>) {
  return (
    <>
      <div className="lede">
        <div>
          <p>{view.lede}</p>
        </div>
      </div>
      <Table
        columns={["Name", "Created", "Last call", "State", ""]}
        empty="No keys yet."
        rows={view.rows.map((row) => ({
          key: row.id,
          ...(row.revoked === null ? {} : { className: "off" }),
          cells: [
            {
              content: (
                <>
                  <div className="title">{row.label}</div>
                  <div className="under mono">{row.id}</div>
                </>
              ),
            },
            { className: "quiet moment", content: <Moment at={row.created} /> },
            row.lastCall === null
              ? { className: "quiet", content: NO_CALLS_RECORDED }
              : { className: "quiet moment", content: <Moment at={row.lastCall} /> },
            {
              className: "quiet",
              content:
                row.revoked === null ? (
                  "Works"
                ) : (
                  <>
                    Revoked <Moment at={row.revoked} />
                  </>
                ),
            },
            { className: "control", content: row.revoked === null ? <Revoke id={row.id} /> : null },
          ],
        }))}
      />
      {view.rows.length === 0 ? null : (
        <>
          {/* Beside the Revoke buttons, where the decision is made. */}
          <p className="note">
            A revoked key stops working at once and for good. Your other keys keep working, and your
            dashboard sign-in does not change. You can create a new key to replace it.
          </p>
          <p className="note">
            This list is what the gateway returned, and it does not say whether that is every key.
            The number above counts the rows below, nothing more.
          </p>
          <p className="note">
            {`The last call time updates every few minutes, so it can lag a little behind. "${NO_CALLS_RECORDED}" does not mean the key was never used: we started recording calls recently, so for an older key this page cannot tell which it is until the key is used again.`}
          </p>
        </>
      )}
      <div className="lede">
        <div>
          <h2>A new key</h2>
          <p>
            The name helps you tell keys apart. The key itself is shown only once, right after you
            create it.
          </p>
        </div>
      </div>
      <PostForm className="issue key-name" action="/keys" replace={false}>
        {(pending) => (
          <>
            <div>
              <label htmlFor="label">What this key is for</label>
              <input
                id="label"
                name="label"
                type="text"
                autoComplete="off"
                autoFocus={view.startNew}
                required
              />
            </div>
            <Button pending={pending}>Issue a key</Button>
            {view.problem === null ? null : <p className="problem">{view.problem}</p>}
          </>
        )}
      </PostForm>
    </>
  );
}

/**
 * Copying needs the page's script; where it did not run, or the browser
 * refuses, the key is selected by hand, as the line beside the button says.
 */
export function NewKeyScreen({ view }: Readonly<{ view: NewKeyView }>) {
  const [said, setSaid] = useState("");
  const [left, setLeft] = useState(false);
  const navigate = useNavigate();
  // A browser may keep a page it leaves whole and show it again as it was, so
  // the secret comes off the page as it is left, and a page brought back
  // draws the list.
  useEffect(() => {
    const leave = () => flushSync(() => setLeft(true));
    const back = (event: PageTransitionEvent) => {
      if (event.persisted) void navigate("/keys", { replace: true });
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
    };
  }, [navigate]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.secret);
      setSaid("Copied.");
    } catch {
      setSaid("Could not copy. Select the key above.");
    }
  };
  return (
    <>
      <div className="lede">
        <div>
          <p>
            {`This is the key for "${view.label}". It is shown only here and only once: we do not keep a readable copy. If you do not copy it now, you will have to create a new one.`}
          </p>
        </div>
      </div>
      <div className="scroller">
        <p className="secret">{left ? "" : view.secret}</p>
      </div>
      <p>
        <Button type="button" onClick={() => void copy()}>
          Copy key
        </Button>{" "}
        <span role="status">{said}</span>
      </p>
      <p className="note">
        Save the key where your code reads it from before you leave this page. If your browser asks
        to resend the form, cancel: resending creates another key.
      </p>
      <p className="quiet">
        {/* Followed inside the application, it takes the page's place in
            history, and the secret goes with it. */}
        <Link to="/keys">Back to your API keys</Link>
      </p>
    </>
  );
}
