import type { ComponentProps } from "react";
import type { NewKeyView } from "../../src/keys.js";
import type { OnboardingView } from "../../src/onboarding.js";
import { NewKeyScreen } from "./new-key.js";
import { OnboardingScreen } from "./onboarding.js";

// Loading the form also loads its one-time disclosure, before Create key is available.
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
      {issued === undefined ? null : <NewKeyScreen view={issued} doneTo="/products" />}
    </>
  );
}
