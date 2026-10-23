/**
 * The little schema machinery this package needs, written against the shape of
 * a result rather than against zod. zod arrives beneath
 * `@nuanu-ai/agentify-contracts` and is not this package's dependency, so under
 * a strict install it would not even resolve here. Nothing here validates; it
 * carries the contract schemas' findings into the shape a merchant reads.
 */

import type { Problem, ReadFinding } from "@nuanu-ai/agentify-contracts";

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

/** How many findings one sentence names before it counts the rest. */
const NAMED_AT_MOST = 10;

const written = (path: readonly string[]): string =>
  path.length === 0 ? "the document as a whole" : path.join(".");

const sentencesOf = (finding: ReadFinding): string[] => {
  switch (finding.code) {
    case "unrecognized_keys":
      return (finding.keys ?? []).map(
        (key) => `${written([...finding.path, key])} is a field this release does not know`,
      );
    case "invalid_key":
      return [
        `a key under ${finding.path.length === 0 ? "the document" : finding.path.join(".")} does not fit`,
      ];
    case "invalid_union":
      return [`${written(finding.path)} takes none of the shapes this release knows`];
    case "invalid_type":
      return [`${written(finding.path)}: expected ${finding.expected ?? UNNAMED_FINDING}`];
    default:
      return [`${written(finding.path)}: ${finding.code}`];
  }
};

/**
 * Where a document failed its schema, by field and by what was expected
 * there, from findings that carry no value (`findingsOf` in the contracts):
 * the gateway's documents carry the buyer's parameters and prices, and a
 * merchant's failures go to logs. Past `most` findings, the rest are counted
 * rather than named.
 */
export const whereItFailed = (
  findings: readonly ReadFinding[],
  most: number = NAMED_AT_MOST,
): string => {
  const found = findings.flatMap(sentencesOf);
  const named = found.slice(0, most).join("; ");

  return found.length > most ? `${named}; and ${found.length - most} more, not named` : named;
};

/**
 * Whether every finding is something added rather than something broken: a
 * field this release does not know, or a shape none of whose kinds it knows.
 * Only then may a merchant be told that a newer release may read it.
 */
export const onlyWhatIsNew = (findings: readonly ReadFinding[]): boolean =>
  findings.length > 0 &&
  findings.every(
    (finding) => finding.code === "unrecognized_keys" || finding.code === "invalid_union",
  );
