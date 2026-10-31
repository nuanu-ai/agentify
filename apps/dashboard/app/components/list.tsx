import type { ReactNode } from "react";

/**
 * What a row's details hold, each fact a label beside its value, in the one
 * look every list's details share; on a narrow box the label goes over the
 * value.
 */
export const Facts = ({ children }: Readonly<{ children: ReactNode }>) => (
  <dl className="more-facts">{children}</dl>
);

export const Fact = ({ label, children }: Readonly<{ label: string; children: ReactNode }>) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);
