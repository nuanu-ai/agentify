/**
 * Shared assertions for the contract tests: every required field of a schema
 * has a negative test, and each demands the error a merchant will read. Not
 * published; its name keeps it out of the test glob.
 */

import { expect } from "vitest";
import { z } from "zod";

/**
 * Drops one top-level field from an otherwise valid value and demands that the
 * schema refuses the result and that the error names the missing field, since
 * "invalid input" leaves a merchant guessing which of nine fields is wrong.
 * Nested objects are schemas of their own, with their own tests.
 */
export const expectMissingFieldRejected = (
  schema: z.ZodType,
  valid: Record<string, unknown>,
  field: string,
): void => {
  expect(Object.hasOwn(valid, field), `${field} is not present in the valid value`).toBe(true);

  const withoutField = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== field));
  const result = schema.safeParse(withoutField);

  expect(result.success, `the schema accepted a value without "${field}"`).toBe(false);
  if (result.success) return;

  // The complaint has to point at this field, not merely mention its name:
  // `id` would pass against a message about `order_id`.
  const issues = result.error.issues;
  expect(
    issues.some((issue) => issue.path[0] === field),
    `nothing in the error points at "${field}": ${z.prettifyError(result.error)}`,
  ).toBe(true);
  expect(z.prettifyError(result.error)).toContain(field);
};

/** The error a schema produced, rendered the way a consumer would read it. */
export const errorOf = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  expect(result.success, "the schema accepted a value that the test expects it to reject").toBe(
    false,
  );
  return result.success ? "" : z.prettifyError(result.error);
};
