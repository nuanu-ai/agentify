import { useEffect, useState } from "react";

/**
 * Eased value of a count-up at a given progress (0..1). easeOutCubic, so the
 * number rushes up then settles — matching the design's "counters ease-out".
 * Pure and deterministic; the animation loop lives in useCountUp.
 */
export function countUpValue(progress: number, target: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const eased = 1 - Math.pow(1 - p, 3);
  return Math.round(target * eased);
}

/**
 * Animates a number from 0 to target over durationMs using requestAnimationFrame.
 * Honors prefers-reduced-motion by snapping straight to the target (motion
 * contract: reduced-motion snaps to final state).
 */
export function useCountUp(target: number, durationMs = 1000): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      setValue(target);
      return;
    }
    const prefersReduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (prefersReduced || target <= 0) {
      setValue(target);
      return;
    }

    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const progress = (now - start) / durationMs;
      if (progress >= 1) {
        setValue(target);
        return;
      }
      setValue(countUpValue(progress, target));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Safety net: requestAnimationFrame is paused in hidden/background tabs, so
    // guarantee the final value even if the animation never gets to run.
    const settle = window.setTimeout(() => setValue(target), durationMs + 100);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [target, durationMs]);

  return value;
}
