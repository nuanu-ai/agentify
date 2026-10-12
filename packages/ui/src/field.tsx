import { type InputHTMLAttributes, useId } from "react";

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
 * found.
 */
export function Field({ label, hint, error, id, ...input }: FieldProps) {
  const own = useId();
  const box = id ?? own;
  const line = `${box}-line`;
  const said = error ?? hint;
  return (
    <div className="field">
      <label className="field-label" htmlFor={box}>
        {label}
      </label>
      <input
        {...input}
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
