/**
 * A section of the workspace before its area is built. Each area replaces its
 * use of this with its screen; the last one deletes this file and
 * `src/admin/placeholder.ts`.
 */

import type { PlaceholderView } from "../../../src/admin/placeholder.js";

export function Placeholder({ view }: Readonly<{ view: PlaceholderView }>) {
  return (
    <div className="lede" data-section={view.section}>
      <div>
        <p>This section of the workspace is not built yet.</p>
      </div>
    </div>
  );
}
