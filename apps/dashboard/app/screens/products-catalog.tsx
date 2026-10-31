import { lazy, Suspense } from "react";
import type { CardsView } from "../../src/views.js";
import { Frame } from "../components/frame.js";
import { AllSelling, CardsScreen } from "./cards.js";
import "./shop-job.module.css";

const ShopJobSummary = lazy(() =>
  import("./shop-job-summary.js").then(({ ShopJobSummary }) => ({ default: ShopJobSummary })),
);

const WooProblem = lazy(() =>
  import("./woo-problem.js").then(({ WooProblem }) => ({ default: WooProblem })),
);

export function ProductsCatalog({
  view,
  base,
  shop,
}: Readonly<{ view: CardsView; base: string; shop: CardsView["shop"] }>) {
  return (
    <Frame tab="products" title="Products" action={<AllSelling view={view} />}>
      {shop?.connection?.access === "read_write" && !shop.connection.onCode ? (
        <>
          {shop.connection.importing === null ? null : (
            <Suspense fallback={<p className="problem">{shop.connection.importing.says}</p>}>
              <WooProblem said={shop.connection.importing} base={base} />
            </Suspense>
          )}
          <Suspense fallback={null}>
            <ShopJobSummary
              initial={shop.job ?? null}
              noProducts={view.empty !== null}
              endpoint={`${base}/shop-job`}
              summaryTo="/woocommerce"
              checkAction="/products?woo=check"
            />
          </Suspense>
        </>
      ) : null}
      <CardsScreen view={view} base={base} />
    </Frame>
  );
}
