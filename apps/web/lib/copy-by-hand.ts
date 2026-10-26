import { useEffect, useRef, useState } from "react";

const wholeTextSelected = (area: HTMLTextAreaElement) =>
  document.activeElement === area &&
  area.value.length > 0 &&
  area.selectionStart === 0 &&
  area.selectionEnd === area.value.length;

/**
 * A box the visitor copies from by hand where the clipboard is refused.
 * `press` counts the presses that ended here, and is undefined while the box
 * is not shown. After each such press, once React has drawn the box, it is
 * focused and its whole text selected. `selected` is true only while the
 * browser has the whole text selected in the box, so a page can say the text
 * is selected exactly when it is. Spread `events` on the box.
 */
export function useCopyByHand(press: number | undefined) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState(false);

  useEffect(() => {
    const area = box.current;
    if (press === undefined || area === null) {
      setSelected(false);
      return;
    }
    area.focus();
    area.select();
    setSelected(wholeTextSelected(area));
  }, [press]);

  const events = {
    onFocus: (event: { currentTarget: HTMLTextAreaElement }) => {
      event.currentTarget.select();
      setSelected(wholeTextSelected(event.currentTarget));
    },
    onBlur: () => setSelected(false),
  };

  return { box, events, selected };
}
