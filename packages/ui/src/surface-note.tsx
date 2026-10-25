/** Which stack a page is drawn on: its mode, and the words said about it, none on the live one. */
interface Surface {
  /** The attribute the mode is marked with. */
  readonly attribute: string;
  readonly mode: string;
  readonly words: string | null;
}

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
