/**
 * What a section of the workspace draws until its area is built: the frame
 * and one sentence. Each area deletes its use of this when its screen lands,
 * and the last one deletes this file.
 */

import type { Outcome } from "../page-services.js";
import type { AdminSection } from "./frame.js";

export interface PlaceholderView {
  readonly section: AdminSection;
}

export const placeholder = async (section: AdminSection): Promise<Outcome<PlaceholderView>> => ({
  kind: "view",
  view: { section },
});
