import { z } from "zod";

import { SCAN_RUBRIC_VERSION } from "./checks.js";
import { uuidV7Schema } from "./api.js";
import { segmentSchema } from "./enums.js";

export { browserObservationJobV1Schema } from "./browser-observation.js";
export type { BrowserObservationJobV1 } from "./browser-observation.js";

export const scanJobV1Schema = z
  .object({
    scan_id: uuidV7Schema,
    canonical_target_url: z.url({ protocol: /^https$/ }),
    submitted_without_scheme: z.boolean().optional(),
    segment: segmentSchema,
    rubric_version: z.literal(SCAN_RUBRIC_VERSION),
    deadline_at: z.iso.datetime({ offset: true }),
    attempt_no: z.number().int().min(1).max(2),
  })
  .strict();
export type ScanJobV1 = z.infer<typeof scanJobV1Schema>;
