/**
 * The one way the workspace answers a press: a line under the button that
 * made it, or where its form stood when the page in its new state no longer
 * draws that form. Done carries a tick and says where it is recorded; a
 * refusal is in the colour of a failure; a lost answer is drawn as every
 * unknown in the workspace is, dashed and in no colour of failure, with the
 * page offered again, since the change may have been made.
 */

import { Link } from "react-router";
import type { ActionAnswer } from "../../../src/admin/action.js";
import { IN_THE_JOURNAL, LOST_ANSWER } from "../../../src/admin/words.js";
import { StepUp } from "./step-up.js";

const Tick = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export function PressAnswer({
  answer,
  done,
  unchanged = "It was so already; nothing changed.",
  page,
}: Readonly<{
  answer: ActionAnswer | null;
  /** What the press did, said when it went through: "Admitted to live sales." */
  done: string;
  /** What stood already, said when the press found it so. */
  unchanged?: string;
  /** The page's own address under the dashboard's prefix, read again after a lost answer. */
  page: string;
}>) {
  if (answer === null) return null;
  switch (answer.kind) {
    case "done":
      return (
        <p className="op-answer op-answer-done" role="status">
          <Tick />
          <span>
            {done} {IN_THE_JOURNAL}
          </span>
        </p>
      );
    case "unchanged":
      return (
        <p className="op-answer" role="status">
          {unchanged} {IN_THE_JOURNAL}
        </p>
      );
    case "refused":
      return (
        <p className="op-answer op-answer-refused" role="alert">
          {answer.said}
        </p>
      );
    case "unknown":
      return (
        <p className="op-answer op-answer-unknown" role="status">
          <span className="badge badge-unknown">Outcome unknown</span>{" "}
          <span>
            {LOST_ANSWER} <Link to={page}>Read the page again</Link>
          </span>
        </p>
      );
    case "step-up":
      return <StepUp view={answer.stepUp} pressed />;
  }
}
