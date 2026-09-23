/**
 * One answer for a verification link that was not sent, on both scanner doors.
 *
 * Two walls can stand in front of a link. The scanner keeps its own rolling
 * hour per address and per scan session; the cabinet keeps a minute between
 * two links to one address and three links an hour on top of it, and names in
 * `retry_at` the moment its wall falls. Whichever refused, the person is owed
 * the same two things: that no link went out, and how long the wait really is.
 *
 * The registration route used to answer every refusal with a flat hour, so
 * somebody forty seconds into a one-minute wait was told to come back in an
 * hour and the recovery route said a link was on its way when none was. Both
 * numbers were invented, and inventing one is what this file exists to keep
 * out. The reason is held to the same rule as the number: the cabinet's answer
 * says when it will send again and never which of its two walls refused, so a
 * refusal that came from there states no cause at all. The one wall the
 * scanner can see — an address that has spent its own hour — is the one it
 * names.
 */

import { waitResponse, waitSeconds } from "./http";

/** The wall behind a refusal, as far as the door can actually see it. */
export type LinkWall = "address_hour" | "unspecified";

/** What a request for a link came to, on either door. */
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
