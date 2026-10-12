import { type InputHTMLAttributes, useEffect, useId, useRef } from "react";

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "children"> {
  readonly label: string;
  /** The ordinary line under the box, drawn while nothing is wrong. */
  readonly hint?: string;
  /** Why what was typed was refused; drawn in place of the hint. */
  readonly error?: string;
  /** Only where something outside the field points at the box. */
  readonly id?: string;
}

/**
 * A labelled box with at most one line under it. The box names that line as
 * its description and is marked invalid while the line is a refusal, so a
 * screen reader reads the reason out with the box rather than leaving it to be
 * found. A refused box takes the focus, so what was typed can be corrected at
 * once: a page drawn refused asks the browser for it, and a refusal arriving
 * while the page is open moves it there.
 */
export function Field({ label, hint, error, id, autoFocus, ...input }: FieldProps) {
  const own = useId();
  const box = id ?? own;
  const line = `${box}-line`;
  const said = error ?? hint;
  const typed = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error !== undefined) typed.current?.focus();
  }, [error]);
  return (
    <div className="field">
      <label className="field-label" htmlFor={box}>
        {label}
      </label>
      <input
        {...input}
        ref={typed}
        autoFocus={autoFocus === true || error !== undefined}
        className="field-input"
        id={box}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={said === undefined ? undefined : line}
      />
      {said === undefined ? null : (
        <p className={error === undefined ? "field-hint" : "field-error"} id={line}>
          {said}
        </p>
      )}
    </div>
  );
}
