import { type ReactNode, useLayoutEffect, useRef } from "react";
import styles from "./locked-dialog.module.css";

/** Native modal focus and inert background; only the named action closes it. */
export function LockedDialog({
  title,
  children,
  focusAfter,
}: Readonly<{ title: string; children: ReactNode; focusAfter?: string }>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const held = dialog.current;
    const before = document.activeElement;
    if (held !== null && typeof held.showModal === "function") {
      held.close();
      held.showModal();
    }
    const wrapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || held === null) return;
      const controls = [
        ...held.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([type='hidden']):not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex='0']",
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (first === undefined || last === undefined) {
        event.preventDefault();
        heading.current?.focus();
        return;
      }
      if (
        event.shiftKey
          ? active === first || active === heading.current || active === held
          : active === last
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    held?.addEventListener("keydown", wrapFocus);
    heading.current?.focus();
    return () => {
      held?.removeEventListener("keydown", wrapFocus);
      held?.close?.();
      queueMicrotask(() => {
        const destination =
          focusAfter === undefined ? null : document.querySelector<HTMLElement>(focusAfter);
        if (destination !== null) destination.focus();
        else if (before instanceof HTMLElement && before.isConnected) before.focus();
      });
    };
  }, [focusAfter]);
  return (
    <div className={styles.scrim}>
      <dialog
        aria-modal="true"
        ref={dialog}
        open
        className={styles.dialog}
        aria-labelledby="dialog-title"
        onCancel={(event) => event.preventDefault()}
      >
        <h2 ref={heading} id="dialog-title" tabIndex={-1}>
          {title}
        </h2>
        {children}
      </dialog>
    </div>
  );
}
