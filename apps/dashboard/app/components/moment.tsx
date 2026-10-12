import type { MomentView } from "../../src/views.js";

/**
 * The only way a page prints an instant. Allowed to wrap between date and time
 * and nowhere else, with nothing added to the text, so a copied moment is the
 * moment. The two halves sit in one span of their own, because where a table
 * row is drawn as a block Chrome and WebKit drop a space between two spans
 * directly inside a cell.
 */
export function Moment({ at }: Readonly<{ at: MomentView }>) {
  return "text" in at ? (
    at.text
  ) : (
    <span className="when">
      <span>{at.date}</span> <span>{at.time}</span>
    </span>
  );
}
