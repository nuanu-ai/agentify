/**
 * The states every page of the workspace shares, the foundation's: the frame
 * with counts, the answer to somebody the flag does not confirm, the step that
 * asks for a fresh sign-in, and an address that is no page.
 */

import type { SurfaceMode } from "@agentify/core";
import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS } from "@agentify/ui/surface";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";
import type { StepUpLink, StepUpView } from "../../src/admin/step-up.js";
import { momentView } from "../../src/views.js";
import type { Trouble } from "../answer.js";
import { OVERVIEW_EXAMPLE } from "./figures.js";
import { type AdminGalleryState, frameIn, LIVE_WAITING } from "./state.js";

const chromeIn = (mode: SurfaceMode) => ({
  base: "",
  surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode, words: SURFACE_WORDS[mode] },
});

const stepUp = (link: StepUpLink | null): StepUpView => ({
  email: "operator@example.com",
  signedInAt: momentView("2026-10-23T12:05:00Z"),
  destination: "admin/merchants/mch_78f0c3eaf1edb0c9086a6d2ae1731c28",
  googleEnabled: true,
  link,
});

const askedAgain = (
  told: Pick<AdminGalleryState, "id" | "when" | "cause">,
  link: StepUpLink,
): AdminGalleryState => ({
  ...told,
  screen: "Confirm it is you",
  path: "/admin/sign-in-again",
  mode: "live",
  loaded: { "routes/admin/sign-in-again": null },
  pressed: { "routes/admin/sign-in-again": stepUp(link) },
});

export const WORKSPACE_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-counts",
    screen: "Overview",
    when: "An operator opens the workspace while merchants wait for admission and payments are unknown.",
    cause:
      "Each section's area counts what waits in it; the red count is a decision only an operator can take.",
    path: "/admin",
    mode: "live",
    frame: frameIn("live", LIVE_WAITING),
    loaded: { "routes/admin/index": OVERVIEW_EXAMPLE },
  },
  {
    id: "dashboard-admin-not-an-operator",
    screen: "There is no such page",
    when: "Somebody signed in without the operator flag opens any page of the workspace.",
    cause:
      "The workspace's layout reads the flag before any page runs and answers as the dashboard answers an address it does not have; an account with no merchant is sent to make one instead.",
    path: "/admin/merchants",
    mode: "live",
    // Signed in as a merchant, whose header has no door into the workspace.
    loaded: { "routes/gate": { who: "owner@example.com" } },
    failed: {
      // Drawn by the gate's boundary, the nearest above the layout that threw,
      // as the dashboard's own page for an address it does not have.
      "routes/gate": new ErrorResponseImpl(404, "", {
        kind: "no-such-page",
        chrome: chromeIn("live"),
        drawn: { who: "owner@example.com", framed: { account: [] } },
      } satisfies Trouble),
    },
  },
  askedAgain(
    {
      id: "dashboard-admin-sign-in-again-sent",
      when: "An operator whose sign-in is older than fifteen minutes asked for a link to confirm an action.",
      cause: "The link went to the operator's own address; it returns this browser to the page.",
    },
    { sent: true, seconds: 60 },
  ),
  askedAgain(
    {
      id: "dashboard-admin-sign-in-again-wait",
      when: "An operator asks for another link within a minute of the last.",
      cause: "The address's own minute between two links refused it; the earlier link still opens.",
    },
    { wall: "interval", seconds: 40 },
  ),
  askedAgain(
    {
      id: "dashboard-admin-sign-in-again-unavailable",
      when: "An operator asks for a link while the mail provider refuses it.",
      cause: "The provider did not take the message, so no link is on its way.",
    },
    { unavailable: true },
  ),
  {
    id: "dashboard-admin-no-such-page",
    screen: "There is no such page",
    when: "An operator opens an address under the workspace that is none of its pages.",
    cause: "No page of the workspace matches the address.",
    path: "/admin/nothing-here",
    mode: "test",
    loaded: { "routes/admin/no-such-page": null },
  },
];
