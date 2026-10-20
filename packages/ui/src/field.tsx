import {
  type InputHTMLAttributes,
  type RefObject,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from "react";
import { useNavigation } from "react-router";

export interface FieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id" | "children"> {
  readonly label: string;
  /** The ordinary line under the box, drawn while nothing is wrong. */
  readonly hint?: string;
  /** Why what was typed was refused; drawn in place of the hint. */
  readonly error?: string;
  /** Only where something outside the field points at the box. */
  readonly id?: string;
  /**
   * How many lines the box shows, for text that may break its lines; the
   * breaks are kept. Without it the box is one line, which drops them.
   */
  readonly rows?: number;
}

/**
 * A labelled box with at most one line under it. The box names that line as
 * its description and is marked invalid while the line is a refusal, so a
 * screen reader reads the reason out with the box rather than leaving it to be
 * found. A refused box takes the focus, so what was typed can be corrected at
 * once: a page drawn refused asks the browser for it, and each time a press
 * answered on the open page settles with the box refused, the focus moves
 * there, though the refusal's words are the last one's.
 */
export function Field({ label, hint, error, id, autoFocus, rows, ...input }: FieldProps) {
  const own = useId();
  const box = id ?? own;
  const line = `${box}-line`;
  const said = error ?? hint;
  const typed = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const settled = useNavigation().state === "idle";
  useEffect(() => {
    if (settled && error !== undefined) typed.current?.focus();
  }, [settled, error]);
  const focused = autoFocus === true || error !== undefined;
  const invalid = error === undefined ? undefined : true;
  const described = said === undefined ? undefined : line;
  return (
    <div className="field">
      <label className="field-label" htmlFor={box}>
        {label}
      </label>
      {rows === undefined ? (
        <input
          {...input}
          ref={typed}
          // biome-ignore lint/a11y/noAutofocus: a refused submission returns focus to its invalid field; callers may also request initial focus
          autoFocus={focused}
          className="field-input"
          id={box}
          aria-invalid={invalid}
          aria-describedby={described}
        />
      ) : (
        <textarea
          {...(input as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          ref={typed as RefObject<HTMLTextAreaElement>}
          rows={rows}
          // biome-ignore lint/a11y/noAutofocus: as the one-line box's
          autoFocus={focused}
          className="field-input"
          id={box}
          aria-invalid={invalid}
          aria-describedby={described}
        />
      )}
      {said === undefined ? null : (
        <p className={error === undefined ? "field-hint" : "field-error"} id={line}>
          {said}
        </p>
      )}
    </div>
  );
}
