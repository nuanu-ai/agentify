/**
 * One answer for a verification link that was not sent, for registration and
 * recovery alike: that no link went out, and how long the wait really is.
 *
 * The scanner's own hourly limits or the dashboard's cooldown can refuse. The
 * dashboard's answer carries `retry_at` but never which of its limits refused,
 * so a cause is named only when the scanner can see it: an address that has
 * spent its own hour. Neither the wait nor the cause is ever made up.
 */

import { waitResponse, waitSeconds } from "./http";

/** The limit behind a refusal, as far as the scanner can see it. */
export type LinkWall = "address_hour" | "unspecified";

export type LinkSendOutcome =
  | Readonly<{ sent: true }>
  | Readonly<{ sent: false; retryAt: Date; wall: LinkWall }>;

const LINK_COOLDOWN_CODE = "verification_link_cooldown";

const counted = (amount: number, unit: string): string =>
  `${amount} ${unit}${amount === 1 ? "" : "s"}`;

const inMinutes = (seconds: number): string =>
  counted(Math.max(1, Math.ceil(seconds / 60)), "minute");

export function linkCooldownMessage(wall: LinkWall, seconds: number): string {
  if (wall === "address_hour") {
    return `No new link was sent: this address has had all the links it gets in an hour. You can ask for another in ${inMinutes(seconds)}.`;
  }
  const wait = seconds < 60 ? counted(seconds, "second") : inMinutes(seconds);
  return `No new link was sent yet. You can ask for another in ${wait}.`;
}

export function linkCooldownResponse(
  request: Request,
  outcome: Readonly<{ retryAt: Date; wall: LinkWall }>,
  now = new Date(),
) {
  const seconds = waitSeconds(outcome.retryAt, now);
  return waitResponse(
    request,
    429,
    LINK_COOLDOWN_CODE,
    linkCooldownMessage(outcome.wall, seconds),
    seconds,
  );
}
