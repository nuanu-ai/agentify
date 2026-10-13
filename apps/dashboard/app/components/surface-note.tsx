import type { Surface } from "../../src/page-services.js";

/**
 * The band naming the stack, and on the live one an empty marker with no band:
 * the marker names the mode rather than merely existing, because an absence
 * cannot tell a correct live page from one that failed to draw.
 */
export function SurfaceNote({ surface }: Readonly<{ surface: Surface }>) {
  const marker = { [surface.attribute]: surface.mode };
  return surface.words === null ? (
    <div {...marker} />
  ) : (
    <div className="stack-note" {...marker}>
      <div className="container">
        <p className="surface-words">{surface.words}</p>
      </div>
    </div>
  );
}
