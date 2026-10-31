import { Button } from "@agentify/ui";
import { useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router";
import type { NewKeyView } from "../../src/keys.js";
import { LockedDialog } from "../dialogs/locked-dialog.js";
import styles from "./keys.module.css";

/**
 * Copying needs the page's script; where it did not run, or the browser
 * refuses, the key is selected by hand, as the line beside the button says.
 */
export function NewKeyScreen({
  view,
  doneTo = "/keys",
}: Readonly<{ view: NewKeyView; doneTo?: string }>) {
  const [alive, setAlive] = useState(false);
  useEffect(() => setAlive(true), []);
  const [said, setSaid] = useState("");
  const [left, setLeft] = useState(false);
  const navigate = useNavigate();
  // A browser may keep a page it leaves whole and show it again as it was, so
  // the secret comes off the page as it is left, and a page brought back
  // draws the list. The listeners go on in the commit that draws the secret:
  // an ordinary effect runs a turn later, and a page left inside that turn
  // would keep it.
  useLayoutEffect(() => {
    const leave = () => flushSync(() => setLeft(true));
    const back = (event: PageTransitionEvent) => {
      if (event.persisted) void navigate(doneTo, { replace: true });
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
    };
  }, [navigate, doneTo]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.secret);
      setSaid("Copied.");
    } catch {
      setSaid("Couldn't copy. Select the key and copy it.");
    }
  };
  if (alive)
    return left ? null : (
      <LockedDialog
        title="Copy your new key"
        focusAfter={doneTo === "/products" ? "#code-quickstart" : "#create-api-key"}
      >
        <p>
          This is the only time we show it. We keep no readable copy, so if you lose it, create a
          new key.
        </p>
        <p>{view.label}</p>
        <input
          aria-label="New API key"
          className={styles.secret}
          readOnly
          value={view.secret}
          onFocus={(event) => event.target.select()}
          onClick={(event) => event.currentTarget.select()}
        />
        <p role="status">{said}</p>
        <p>Keep it with your other secrets, out of source control.</p>
        <div className={styles.secretActions}>
          <Button type="button" onClick={() => void copy()}>
            Copy
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setLeft(true);
              void navigate(doneTo, { replace: true });
            }}
          >
            Done
          </Button>
        </div>
      </LockedDialog>
    );
  return (
    <>
      <div className="lede">
        <div>
          <p>{`Copy the key for “${view.label}” now. We show it only once and keep no readable copy.`}</p>
        </div>
      </div>
      <div className="scroller">
        <p className="secret">{left ? "" : view.secret}</p>
      </div>
      <p className="copy-row">
        <Button type="button" onClick={() => void copy()}>
          Copy key
        </Button>{" "}
        <span role="status">{said}</span>
      </p>
      <p className="note">
        If your browser offers to send the form again, cancel: that creates a second key.{" "}
        <a href="/docs/quickstart#_2-install-the-package-and-build-a-client">
          How your code uses the key
        </a>
      </p>
      <p className="quiet">
        {/* Followed inside the application, it takes the page's place in
            history, and the secret goes with it. */}
        <Link className="button button-secondary" to={doneTo} replace>
          Done
        </Link>
      </p>
    </>
  );
}
