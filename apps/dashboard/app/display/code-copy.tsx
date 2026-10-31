import { SAID, Tick, useCopy } from "./clipboard.js";

const Chain = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
);

/**
 * A product code with the button beside it that copies the address an agent
 * buys the card at, which is not printed: it is for an agent or a terminal,
 * and without payment it answers with a payment request, not a page. The
 * address is the button's title, so it is reachable before the page's script
 * runs; where copying fails, the address is shown under the code.
 */
export function CodeCopy({ code, address }: Readonly<{ code: string; address: string }>) {
  const { copied, copy } = useCopy(address);
  return (
    <span className="code">
      {code}
      <button
        type="button"
        className={copied === "copied" ? "copy copied" : "copy"}
        aria-label={`Copy the purchase address of ${code}`}
        title={`Copy the purchase address: ${address}`}
        onClick={copy}
      >
        {copied === "copied" ? <Tick /> : <Chain />}
      </button>
      <span className="sr-only" role="status">
        {SAID[copied]}
      </span>
      {copied === "failed" ? <span className="copy-whole">{address}</span> : null}
    </span>
  );
}
