import { Button } from "@agentify/ui";
import type { WalletChangeNote } from "../../src/account-banner.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Address } from "../wallet/address.js";
import styles from "./account-banner.module.css";

/**
 * The cancel, pressed from whichever page the banner is on and brought back to
 * it. It carries the change it showed, as the settings' own cancel does. On
 * Settings the wallet's section holds the cancel, so the banner has none.
 */
function CancelChange({ change, back }: Readonly<{ change: WalletChangeNote; back: string }>) {
  return (
    <PostForm document action="/settings/payout-wallet/cancel" className={styles.cancel}>
      {(pressed) => (
        <>
          <input type="hidden" name="waiting" value={change.wallet} />
          <input type="hidden" name="waiting_from" value={change.takesEffectAt} />
          <input type="hidden" name="paid" value={change.paid ?? ""} />
          <input type="hidden" name="back" value={back} />
          <Button variant="secondary" compact pending={pressed}>
            Cancel this change
          </Button>
        </>
      )}
    </PostForm>
  );
}

/** The saved wallet change, including the cancel where Settings does not already offer it. */
export function WalletChangeReason({
  change,
  here,
  back,
  says,
}: Readonly<{ change: WalletChangeNote; here: string; back: string; says: string }>) {
  return (
    <>
      From <Moment at={change.from} />, your share of each sale goes to{" "}
      <Address address={change.wallet} />. {says}
      {here === "/settings" || here.startsWith("/settings/") ? (
        <>
          {" "}
          <a href="#wallet-change">Review wallet change</a>
        </>
      ) : (
        <CancelChange change={change} back={back} />
      )}
    </>
  );
}
