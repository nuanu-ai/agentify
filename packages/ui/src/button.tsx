import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  readonly variant?: "primary" | "secondary";
  /** For a table row, where a full-height button would read as the row itself. */
  readonly compact?: boolean;
  /**
   * A press on its way to the server. The button keeps its words and colours,
   * so the page does not change its story before the server answers, and takes
   * no second press.
   */
  readonly pending?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = "primary",
  compact = false,
  pending = false,
  type = "submit",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = ["button", `button-${variant}`, ...(compact ? ["button-compact"] : [])];
  return (
    <button
      {...rest}
      className={classes.join(" ")}
      type={type}
      disabled={pending || disabled}
      aria-busy={pending ? true : undefined}
    >
      {children}
    </button>
  );
}
