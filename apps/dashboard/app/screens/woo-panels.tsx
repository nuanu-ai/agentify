import { lazy, Suspense } from "react";
import type { Refusal } from "../../src/woo-views.js";

/** Where the connector's rules are written in full; the screens link to it once. */
export const GUIDE = "/docs/woocommerce";

const WooProblem = lazy(() =>
  import("./woo-problem.js").then(({ WooProblem }) => ({ default: WooProblem })),
);

export function Problem({ said, base }: Readonly<{ said: Refusal | null; base: string }>) {
  return said === null ? null : (
    <Suspense fallback={<p className="problem">{said.says}</p>}>
      <WooProblem said={said} base={base} />
    </Suspense>
  );
}
