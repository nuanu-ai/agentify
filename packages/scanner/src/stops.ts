import type { ScanStopReason } from "@agentify/scanner-contracts";

// A scan's own address is held to these rules before the scan is accepted, so
// a check stopped by one of them met it on a redirect.
const REDIRECT_REFUSALS = new Set([
  "url_empty",
  "url_too_long",
  "url_invalid",
  "scheme_blocked",
  "credentials_blocked",
  "hostname_too_long",
  "hostname_blocked",
  "numeric_host_blocked",
  "single_label_host_blocked",
  "hostname_invalid",
  "port_blocked",
  "secret_query_blocked",
  "redirect_invalid",
  "redirect_downgrade_blocked",
  "redirect_limit_exceeded",
]);

// A timeout or a reset connection is left out: the scanner's own deadline
// cuts requests short as a slow site does, and a reset says nothing of why.
// So is a lookup that failed, or answered with no address: that is the
// resolver's state, not the name's. And so is a secure handshake that failed
// or was cut, which a firewall dropping the scanner causes as well.
const stopOf = (errorCode: string | null | undefined): ScanStopReason | null => {
  if (!errorCode) return null;
  if (errorCode.startsWith("ssrf_blocked:") || errorCode === "dns_not_found")
    return "no_public_site";
  if (REDIRECT_REFUSALS.has(errorCode)) return "forbidden_redirect";
  if (errorCode === "tls_certificate_invalid") return "certificate_invalid";
  return null;
};

/**
 * Why the scanner stopped short of what a scan could not assess, when every
 * check it could not assess was stopped for the same known reason; null when
 * nothing was stopped, the reasons differ, or any of them is not known.
 */
export const scanStopReason = (
  checks: readonly { status: string; errorCode?: string | null }[],
): ScanStopReason | null => {
  const stops = checks
    .filter((check) => check.status === "unavailable")
    .map((check) => stopOf(check.errorCode));
  const [first] = stops;
  return first && stops.every((stop) => stop === first) ? first : null;
};
