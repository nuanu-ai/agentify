import { Button } from "@agentify/ui";
import { SAID, Tick, useCopy } from "./clipboard.js";

const Squares = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

/** A command stays selectable when the browser cannot copy it. */
export function CommandCopy({ value }: Readonly<{ value: string }>) {
  const { copied, copy } = useCopy(value);
  return (
    <>
      <Button variant="secondary" type="button" onClick={copy}>
        Copy
      </Button>
      <span role="status">
        {copied === "failed" ? "Couldn't copy. Select the command and copy it." : SAID[copied]}
      </span>
    </>
  );
}

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
