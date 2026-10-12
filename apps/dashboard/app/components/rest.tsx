import type { Rest as RestView } from "../../src/views.js";

/** A sentence's last words: where the documentation carries the mechanism. */
export function Rest({ rest }: Readonly<{ rest: RestView }>) {
  return (
    <>
      {" "}
      <a href={rest.href}>{rest.words}</a>.
    </>
  );
}
