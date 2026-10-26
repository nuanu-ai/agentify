/**
 * The include a page writes as `<<< @/examples/card/x.json`: the path after
 * `<<<`, with `@/` naming this application.
 */

import { extname } from "node:path";
import { APP } from "./where.server.js";

/** The path a line includes, or undefined for a line that includes nothing. */
export const includeOf = (line: string): string | undefined => /^<<<\s+(\S+)/.exec(line)?.[1];

/**
 * The file an included path names. A region or options after the path would
 * be a part of the file the build does not know how to cut, so they are
 * refused rather than the whole file shown in their place.
 */
export const includedFile = (named: string): string => {
  if (/[#{]/.test(named))
    throw new Error(`"<<< ${named}" names a region or options; include the whole file`);
  return named.replace(/^@\//, `${APP}/`);
};

/**
 * The language an included file is shown in. A program a reader saves as
 * `buyer.mts` is TypeScript, which is the name the highlighter knows it by.
 */
export const languageOf = (file: string): string => {
  const extension = extname(file).slice(1);
  return extension === "mts" ? "ts" : extension;
};
