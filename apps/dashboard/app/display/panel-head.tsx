import type { ReactNode } from "react";

/** A panel's heading and its words, with what the last press in it came to under the heading. */
export function PanelHead({
  title,
  said,
  children,
}: Readonly<{ title: string; said?: ReactNode; children?: ReactNode }>) {
  return (
    <div className="lede">
      <div>
        <h2>{title}</h2>
        {said}
        {children}
      </div>
    </div>
  );
}
