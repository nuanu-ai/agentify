import { useEffect, useRef, useState } from "react";

type Copied = "idle" | "copied" | "failed";

/** How long the button says it copied before it is ready again. */
const SAID_FOR_MS = 2_000;

/**
 * Copying needs the page's script and a browser that lets the page write to
 * the clipboard; where either is missing the press says it could not copy.
 */
const useCopy = (value: string) => {
  const [copied, setCopied] = useState<Copied>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
      timer.current = setTimeout(() => setCopied("idle"), SAID_FOR_MS);
    } catch {
      setCopied("failed");
    }
  };
  return { copied, copy: () => void copy() };
};

const Squares = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

const Chain = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
);

const Tick = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12 5 5L20 7" />
  </svg>
);

const SAID: Readonly<Record<Copied, string>> = {
  idle: "",
  copied: "Copied",
  failed: "Could not copy; select it",
};

/**
 * An identifier's prefix up to its first underscore, then its first four and
 * last four characters with an ellipsis between; one too short to gain from
 * it is left whole.
 */
export const shortened = (value: string): string => {
  const cut = value.indexOf("_") + 1;
  const prefix = value.slice(0, cut);
  const rest = value.slice(cut);
  return rest.length <= 10 ? value : `${prefix}${rest.slice(0, 4)}…${rest.slice(-4)}`;
};

/**
 * An identifier shown short, with the button beside it that copies the whole
 * of it. The short form opens to the whole value at a press, which the
 * browser does with no script on the page and on a touch screen, where a
 * title is never shown; the whole value is held only there, so a selection
 * across the row copies the identifier once. Where copying fails, the whole
 * value is shown beside it to be selected. `what` names it in the button's
 * words, "order ID", and the short value follows, so a list of buttons read
 * out tells its rows apart. `whole` prints all of it, for the place a narrow
 * row opens to show what it shortened.
 */
export function Ident({
  value,
  what,
  whole = false,
}: Readonly<{ value: string; what: string; whole?: boolean }>) {
  const { copied, copy } = useCopy(value);
  const short = whole ? value : shortened(value);
  return (
    <span className="ident">
      {short === value ? (
        <span>{value}</span>
      ) : (
        <details className="ident-whole">
          <summary title={value}>{short}</summary>
          <span className="ident-all">{value}</span>
        </details>
      )}
      <button
        type="button"
        className={copied === "copied" ? "copy copied" : "copy"}
        aria-label={`Copy the whole ${what} ${short}`}
        title={`Copy the whole ${what}`}
        onClick={copy}
      >
        {copied === "copied" ? <Tick /> : <Squares />}
      </button>
      <span className="sr-only" role="status">
        {SAID[copied]}
      </span>
      {copied === "failed" && short !== value ? <span className="copy-whole">{value}</span> : null}
    </span>
  );
}

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
