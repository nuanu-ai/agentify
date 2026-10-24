/**
 * How many scans the scanner accepts, as the rate check enforces them and as
 * the operator's page states them. One place, so the page cannot go on
 * showing a limit after the limit changes.
 *
 * The free scans are those an address may start in a rolling hour before it
 * must pass the challenge; the two ceilings refuse whatever the challenge
 * says. The site's day is the UTC day.
 */
export const SCAN_LIMITS = {
  freePerAddressHour: 3,
  perAddressHour: 10,
  perSiteDay: 10,
} as const;
