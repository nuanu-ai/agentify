/**
 * A press that failed after its work set cookies the browser must still be
 * sent, such as a new session that replaced an ended one; the page drawn for
 * the failure carries them.
 */
export class FailedAfterSettingCookies extends Error {
  constructor(readonly setCookies: readonly string[]) {
    super("a press failed after setting cookies");
    this.name = "FailedAfterSettingCookies";
  }
}

/**
 * The cookies a failure carries, read by its shape: the pages and the server
 * can each hold their own copy of this module, so `instanceof` can miss.
 */
export const cookiesCarriedBy = (thrown: unknown): readonly string[] => {
  if (!(thrown instanceof Error) || thrown.name !== "FailedAfterSettingCookies") return [];
  const { setCookies } = thrown as { setCookies?: unknown };
  return Array.isArray(setCookies) ? setCookies.filter((line) => typeof line === "string") : [];
};
