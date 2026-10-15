/**
 * What a person reads about telling the ad tracker of their sign-up, and the
 * name of this version of it, which is recorded with every consent given to
 * it: the sentence of the box on the sign-in form, which lets the click be kept
 * with the link, and the sentence on the link's page, where the address's owner
 * confirms it. They change together: a consent is evidence only of the words it
 * was given to.
 *
 * A module of its own with nothing imported, because the sign-in page draws
 * the sentences in the browser too.
 */
export const ADS_CONSENT = {
  version: "2026-10-15",
  sentence:
    "Tell AI Samurai, Agentify's ad tracker, that I signed up after clicking an Agentify ad. Nothing else is shared.",
  /** The privacy page's section that names the tracker and what it is told. */
  explained: { words: "What AI Samurai is told", href: "/privacy#processors" },
} as const;
