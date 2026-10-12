import { Badge, type BadgeTone } from "@agentify/ui";
import type { Tone, Word as WordView } from "../../src/words.js";

/**
 * The dashboard's tones as the shared badge's: what the goods have reached
 * passes, what costs the merchant something fails, what is under way is in
 * progress, and an ending that costs nobody is quiet.
 */
const TONES: Readonly<Record<Tone, BadgeTone>> = {
  ok: "pass",
  warn: "fail",
  busy: "progress",
  quiet: "quiet",
};

/** A state in its word, with the dot that tells it from the sentence beside it. */
export function Word({ word }: Readonly<{ word: WordView }>) {
  return <Badge tone={TONES[word.tone]}>{word.text}</Badge>;
}
