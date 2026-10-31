import { withUnit } from "@agentify/ui/units";
import { useEffect, useRef, useState } from "react";
import { WALLET_ANSWERS_WITHIN_MS } from "./waiting.js";

export const LIMIT = withUnit(WALLET_ANSWERS_WITHIN_MS / 60_000, "minutes");

/** What a press on a button answers when Coinbase Wallet's code could not be fetched or started. */
export const NOT_OPENED = { kind: "notOpened" } as const;

/** False as the server draws the page, true once its script runs. */
export function useScriptRuns(): boolean {
  const [runs, setRuns] = useState(false);
  useEffect(() => setRuns(true), []);
  return runs;
}

/**
 * The status of a button's presses. A button is never held disabled while
 * Coinbase Wallet answers, because its window can vanish without answering,
 * as when a phone closes its tab, and a held button would then stay held; a
 * second press is taken instead.
 */
export function usePresses(
  waiting: string,
): [string, () => Readonly<{ latest: () => boolean; say: (said: string) => void }>] {
  const [said, setSaid] = useState("");
  const counted = useRef(0);
  const press = () => {
    counted.current += 1;
    const mine = counted.current;
    setSaid(waiting);
    return { latest: () => mine === counted.current, say: setSaid };
  };
  return [said, press];
}

/** No press has begun since, where Coinbase Wallet could not be opened to count any. */
export const UNCOUNTED = () => true;
