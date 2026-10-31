import type { ReactNode } from "react";

/** The account's one notice, with its explanation next to the same marker. */
export function Notice({
  title,
  label,
  children,
}: Readonly<{ title: string; label: string; children: ReactNode }>) {
  return (
    <section className="account-banner" aria-label={label}>
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16.5v.5" />
      </svg>
      <div>
        <h2>{title}</h2>
        {children}
      </div>
    </section>
  );
}
