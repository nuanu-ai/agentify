import { lazy, Suspense } from "react";
import type { OnboardingPress, OnboardingView } from "../../src/onboarding.js";
import type { CardsView } from "../../src/views.js";
import { Frame } from "../components/frame.js";
import { AllSelling, CardsScreen } from "./cards.js";

const OnboardingAccount = lazy(() =>
  import("./onboarding-account.js").then(({ OnboardingAccount }) => ({
    default: OnboardingAccount,
  })),
);

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
  account,
  press,
}: Readonly<{
  account?: OnboardingView;
  press?: OnboardingPress;
  view: CardsView;
  base: string;
  shop: CardsView["shop"];
}>) {
  return (
    <Frame
      tab="products"
      title="Products"
      action={
        <AllSelling
          view={view}
          secondary={
            account !== undefined && (account.publicationPending || account.step.account !== "none")
          }
        />
      }
    >
      {account === undefined ||
      (!account.publicationPending && account.step.account === "none" && !press?.problem) ? null : (
        <Suspense fallback={null}>
          <OnboardingAccount view={account} job={shop?.job} press={press} />
        </Suspense>
      )}
      {shop?.connection?.access === "read_write" && !shop.connection.onCode ? (
        <>
          {shop.connection.importing === null ? null : (
            <Suspense fallback={<p className="problem">{shop.connection.importing.says}</p>}>
              <WooProblem said={shop.connection.importing} base={base} />
            </Suspense>
          )}
          <Suspense fallback={null}>
            {/* Only the empty unfiltered Products list establishes there are no products on sale. */}
            <ShopJobSummary
              initial={shop.job ?? null}
              noProducts={view.empty}
              publication={account?.publicationPending ? account.account?.publication : undefined}
              endpoint={`${base}/shop-job`}
              summaryTo="/woocommerce"
              checkAction="/products?woo=check"
            />
          </Suspense>
        </>
      ) : null}
      <CardsScreen view={view} />
    </Frame>
  );
}
