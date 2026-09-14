import {
  browserObservationOutputV1Schema,
  type BrowserObservationOutputV1,
} from "@agentify/scanner-contracts";

const FORBIDDEN_KEY =
  /^(?:raw_|full_)?(?:body|content|cookie|credential|header|html|ip|message|path|query|screenshot|secret|stack|storage|text|token|url)s?$/i;
const URL_LIKE = /(?:https?|file|ftp|wss?):\/\//i;
const IPV4_LIKE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const INSTRUCTION_LIKE =
  /ignore (?:all |any )?(?:previous|prior) instructions|system prompt|assistant must|ai agent must|reveal (?:the )?(?:prompt|secret)/i;

export class OutputSanitizationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "OutputSanitizationError";
  }
}

const inspectValue = (value: unknown, key = ""): void => {
  if (key && FORBIDDEN_KEY.test(key)) {
    throw new OutputSanitizationError("forbidden_output_key");
  }
  if (typeof value === "string") {
    if (
      URL_LIKE.test(value) ||
      IPV4_LIKE.test(value) ||
      INSTRUCTION_LIKE.test(value) ||
      value.includes("?")
    ) {
      throw new OutputSanitizationError("forbidden_output_value");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectValue(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      inspectValue(childValue, childKey);
    }
  }
};

export const sanitizeBrowserOutput = (
  value: unknown,
): BrowserObservationOutputV1 => {
  const parsed = browserObservationOutputV1Schema.parse(value);
  inspectValue(parsed);
  return parsed;
};
