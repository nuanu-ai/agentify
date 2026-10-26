/**
 * Checks that no state of the operator's workspace in the gallery says "this
 * channel", "this deployment" or "this environment": a workspace page names
 * its environment once, in its band, and its sentences say "here".
 *
 * Left alone: the merchant's pages, mails (which have no band and name their
 * environment in words), states the gallery does not show, and every other way
 * a sentence could name its environment wrongly, which the review of the words
 * catches.
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readable } from "../../src/testing/html.js";
import { gallery } from "../gallery.js";

const OPERATORS = gallery.states.filter((state) => state.id.startsWith("dashboard-admin-"));

describe("the operator's workspace", () => {
  it.each(OPERATORS.map((state) => [state.id, state] as const))(
    "says here, not this channel, in %s",
    (_id, state) => {
      expect(readable(renderToString(state.draw()))).not.toMatch(
        /\bthis (?:channel|deployment|environment)\b/i,
      );
    },
  );
});
