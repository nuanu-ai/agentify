import { format } from "node:util";
import { vi } from "vitest";

/**
 * Everything written to the console while `during` runs, each call rendered
 * the way the console renders it: an error with its stack, its own fields and
 * its causes. Whatever a logged value carried, anywhere in it, is in this text.
 */
export async function loggedWhile(during: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...said: unknown[]) => {
      lines.push(format(...said));
    }),
  );
  try {
    await during();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines.join("\n");
}
