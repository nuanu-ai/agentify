import { useEffect, useRef, useState } from "react";

/**
 * A box the visitor copies from by hand where the clipboard is refused. Once
 * React has drawn the box it is focused and its whole text selected, and
 * `selected` turns true only if the browser really did select it all, so a
 * page can say the text is selected only when it is.
 */
export function useCopyByHand(shown: boolean) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState(false);

  useEffect(() => {
    const area = box.current;
    if (!shown || area === null) {
      setSelected(false);
      return;
    }
    area.focus();
    area.select();
    setSelected(
      document.activeElement === area &&
        area.value.length > 0 &&
        area.selectionStart === 0 &&
        area.selectionEnd === area.value.length,
    );
  }, [shown]);

  return { box, selected };
}
