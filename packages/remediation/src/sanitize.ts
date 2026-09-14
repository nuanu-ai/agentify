const PRIVATE_KEY =
  /(?:^|_)(?:url|urls|ip|header|headers|endpoint|body|token|cookie|authorization|secret|trace|stack|email|actor|actor_id|provider|run_id|operation_id)(?:$|_value$|_values$)/i;
const PRIVATE_VALUE =
  /(?:https?:\/\/|(?:^|\s)(?:\d{1,3}\.){3}\d{1,3}(?:\s|$)|bearer\s+|api[_-]?key|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\s)\/[a-z0-9._~!$&'()*+,;=:@%/-]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|\b)|ignore\s+(?:all\s+)?previous\s+instructions?|system\s+prompt|developer\s+message|follow\s+(?:these|my)\s+instructions?)/i;
const containsControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

export type SafeEvidence = Record<string, string | number | boolean | string[]>;

export function safeCode(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().slice(0, 200);
  return /^[a-z0-9][a-z0-9_.:-]*$/i.test(normalized) ? normalized : undefined;
}

export function sanitizeEvidence(value: unknown): SafeEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: SafeEvidence = {};
  for (const [rawKey, item] of Object.entries(value)) {
    const key = safeCode(rawKey);
    if (!key || PRIVATE_KEY.test(key)) continue;
    if (typeof item === "string") {
      if (!PRIVATE_VALUE.test(item) && !containsControlCharacters(item))
        output[key] = item.slice(0, 200);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      output[key] = item;
    } else if (typeof item === "boolean") {
      output[key] = item;
    } else if (Array.isArray(item)) {
      output[key] = item
        .filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            !PRIVATE_VALUE.test(entry) &&
            !containsControlCharacters(entry),
        )
        .slice(0, 20)
        .map((entry) => entry.slice(0, 200));
    }
  }
  return output;
}
