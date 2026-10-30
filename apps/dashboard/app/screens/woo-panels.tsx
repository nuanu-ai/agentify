import { lazy, type ReactNode, Suspense } from "react";
import type { Refusal } from "../../src/woo-views.js";

/** Where the connector's rules are written in full; the screens link to it once. */
export const GUIDE = "/docs/woocommerce";

/** The same words wherever a switch is about products published by code. */
export const codeProducts = (count: number | null): string =>
  count === null
    ? "the products your code published"
    : count === 1
      ? "the product your code published"
      : `the ${count.toLocaleString("en-US")} products your code published`;

/** Said before a Connect: nothing changes for the code's products until the shop's keys arrive. */
export const offSaleOnKeys = (count: number | null): string =>
  `${codeProducts(count)} ${count === 1 ? "goes" : "go"} off sale`;

export const comeBack = (count: number | null): string => {
  const said = codeProducts(count);
  return `${said.charAt(0).toUpperCase()}${said.slice(1)} ${count === 1 ? "comes" : "come"} back paused.`;
};

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

/** A panel's heading and its words, with what the last press in it came to under the heading. */
export function PanelHead({
  title,
  said,
  children,
}: Readonly<{ title: string; said?: ReactNode; children?: ReactNode }>) {
  return (
    <div className="lede">
      <div>
        <h2>{title}</h2>
        {said}
        {children}
      </div>
    </div>
  );
}
