/**
 * This application's own directory, where its Markdown, examples and
 * drawings are. Found by walking up from this module rather than from the
 * working directory, because the module runs from its source under tests and
 * the gallery and from the bundled build under `dist/` when the pages are
 * prerendered.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function appDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "react-router.config.ts"))) {
    const up = dirname(directory);
    if (up === directory) throw new Error("the documentation's directory is not above this module");
    directory = up;
  }
  return directory;
}

export const APP = appDirectory();
