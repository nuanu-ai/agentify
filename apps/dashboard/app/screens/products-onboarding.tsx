import { type ComponentProps, lazy, Suspense } from "react";
import type { NewKeyView } from "../../src/keys.js";
import type { OnboardingView } from "../../src/onboarding.js";
import { OnboardingScreen } from "./onboarding.js";

const NewKeyScreen = lazy(() =>
  import("./onboarding-code.js").then(({ NewKeyScreen }) => ({ default: NewKeyScreen })),
);
export function ProductsOnboarding({
  view,
  issued,
  ...props
}: Readonly<
  Omit<ComponentProps<typeof OnboardingScreen>, "view"> & {
    view?: OnboardingView;
    issued?: NewKeyView;
  }
>) {
  return (
    <>
      {view === undefined ? null : <OnboardingScreen view={view} {...props} />}
      {issued === undefined ? null : (
        <Suspense fallback={null}>
          <NewKeyScreen view={issued} doneTo="/products" />
        </Suspense>
      )}
    </>
  );
}
