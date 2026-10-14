/**
 * The little schema machinery this package needs, written against the shape of
 * a result rather than against zod. zod arrives beneath
 * `@nuanu-ai/agentify-contracts` and is not this package's dependency, so under
 * a strict install it would not even resolve here. Nothing here validates; it
 * carries the contract schemas' findings into the shape a merchant reads.
 */

import type { Problem } from "@nuanu-ai/agentify-contracts";

/**
 * One finding of a schema, as much of it as this package reads. A finding
 * with no code is given `UNNAMED_FINDING`, so a consumer never has to tell "no
 * code" from "the field did not arrive".
 */
export interface SchemaIssue {
  readonly code?: string | undefined;
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** The code a finding travels under when the schema did not name one. */
const UNNAMED_FINDING = "invalid";

/**
 * A schema's findings, in the shape the publish call answers in, so a local
 * check and a refused publish read the same. The path is flattened to text,
 * since an array index would otherwise be a number in one finding and a name
 * in the next.
 */
export const problemsOf = (issues: readonly SchemaIssue[]): Problem[] =>
  issues.map((issue) => ({
    path: issue.path.map(String),
    code: issue.code ?? UNNAMED_FINDING,
    message: issue.message,
  }));

/**
 * The findings as one block of text, one a line, each pointing at its field.
 * A finding with an empty path is written as about the card as a whole, so it
 * cannot be mistaken for a path that went missing.
 */
export const describeProblems = (problems: readonly Problem[]): string =>
  problems
    .map((problem) =>
      problem.path.length === 0
        ? `  the card as a whole: ${problem.message}`
        : `  ${problem.path.join(".")}: ${problem.message}`,
    )
    .join("\n");
