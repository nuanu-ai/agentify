import type { SurfaceMode } from "@agentify/core";
import type { KeysView } from "./keys.js";
import type { NextStep } from "./next-step.js";
import type { MomentView } from "./views.js";

export interface OnboardingView {
  readonly mode: SurfaceMode;
  readonly step: NextStep;
  readonly keys: KeysView | null;
  readonly contact: MomentView | null;
  readonly origin: string;
  readonly unread: boolean;
}
