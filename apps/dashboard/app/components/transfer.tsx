import type { TransferView } from "../../src/views.js";
import { Ident, shortened } from "./copy.js";

/** An arrow out of a box, for a page on another site. */
const Out = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

/**
 * The transfer that paid an order, short with its copy button, and where this
 * deployment has the chain's page for it, a way there.
 */
export const Transfer = ({
  transfer,
}: Readonly<{ transfer: Exclude<TransferView, { kind: "none" }> }>) => (
  <span className="transfer">
    <Ident value={transfer.text} what="transfer" />
    {transfer.kind === "link" ? (
      <a
        className="copy"
        href={transfer.href}
        rel="noreferrer"
        aria-label={`See the transfer ${shortened(transfer.text)} on the chain's explorer`}
        title="See it on the chain's explorer"
      >
        <Out />
      </a>
    ) : null}
  </span>
);
