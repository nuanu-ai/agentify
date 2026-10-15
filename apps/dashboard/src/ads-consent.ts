/**
 * The sentence a person an ad sent ticks on the sign-in form, and the name of
 * this version of it, which is recorded with every consent given to it. They
 * change together: a consent is evidence only of the words it was given to.
 *
 * A module of its own with nothing imported, because the sign-in page draws
 * the sentence in the browser too.
 */
export const ADS_CONSENT = {
  version: "2026-10-15",
  sentence:
    "Tell the advertiser whose ad brought me here that I signed up. Nothing else is shared.",
} as const;
