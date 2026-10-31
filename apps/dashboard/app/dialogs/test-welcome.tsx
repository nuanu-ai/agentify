import { Button } from "@agentify/ui";
import { useEffect, useState } from "react";
import { PostForm } from "../components/post-form.js";
import { LockedDialog } from "./locked-dialog.js";
import styles from "./test-welcome.module.css";

export function TestWelcome({ problem }: Readonly<{ problem?: string }>) {
  const [understood, setUnderstood] = useState(false);
  const [alive, setAlive] = useState(false);
  useEffect(() => setAlive(true), []);
  return (
    <LockedDialog
      title="This is the test environment"
      focusAfter='button[data-platform="woocommerce"]'
    >
      <ul className={styles.testFacts}>
        <li>Money here isn't real. Buyers pay in test USDC on Base Sepolia.</li>
        <li>
          This is a separate account. Nothing here carries over to your real dashboard at
          agentify.ad.
        </li>
        <li>If you connect your real shop, orders made here are test orders. Don't ship them.</li>
      </ul>
      <PostForm action="/products">
        {(pending) => (
          <>
            <input type="hidden" name="intent" value="acknowledge-test" />
            <label className={styles.check}>
              <input
                type="checkbox"
                name="understood"
                value="yes"
                required
                checked={understood}
                onChange={(event) => setUnderstood(event.target.checked)}
              />
              I've read and understood
            </label>
            <Button pending={pending} disabled={alive && !understood}>
              Start testing
            </Button>
            {problem === undefined ? null : (
              <p className="problem" role="alert">
                {problem}
              </p>
            )}
          </>
        )}
      </PostForm>
    </LockedDialog>
  );
}
