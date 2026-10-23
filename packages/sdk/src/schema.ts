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

/**
 * A schema's finding as far as `whereItFailed` reads it. Its message is left
 * out on purpose: a refinement may write the value it refused into it.
 */
export interface FoundIssue {
  readonly code?: string | undefined;
  readonly path: readonly PropertyKey[];
  readonly expected?: unknown;
  readonly keys?: readonly string[];
  readonly errors?: readonly (readonly FoundIssue[])[];
}

/** How many findings one sentence names before it counts the rest. */
const NAMED_AT_MOST = 10;

const written = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? "the document as a whole" : path.map(String).join(".");

const findingsIn = (issue: FoundIssue, under: readonly PropertyKey[]): string[] => {
  const at = [...under, ...issue.path];

  switch (issue.code) {
    case "unrecognized_keys":
      return (issue.keys ?? []).map(
        (key) => `${written([...at, key])} is a field this release does not know`,
      );
    case "invalid_union": {
      // The shape that came closest says the most about what is wrong.
      const closest = [...(issue.errors ?? [])].sort((one, other) => one.length - other.length)[0];

      return closest === undefined
        ? [`${written(at)} takes none of the shapes this release knows`]
        : closest.flatMap((inner) => findingsIn(inner, at));
    }
    case "invalid_type":
      return [`${written(at)}: expected ${String(issue.expected)}`];
    default:
      return [`${written(at)}: ${issue.code ?? UNNAMED_FINDING}`];
  }
};

/**
 * Where a document failed its schema, by field and by what was expected
 * there, and never with the value that failed: the gateway's documents carry
 * the buyer's parameters and prices, and a merchant's failures go to logs.
 * Past `NAMED_AT_MOST` findings, the rest are counted rather than named.
 */
export const whereItFailed = (issues: readonly FoundIssue[]): string => {
  const found = issues.flatMap((issue) => findingsIn(issue, []));
  const named = found.slice(0, NAMED_AT_MOST).join("; ");

  return found.length > NAMED_AT_MOST
    ? `${named}; and ${found.length - NAMED_AT_MOST} more, not named`
    : named;
};
