import { isIP } from "node:net";

const TRACKING_KEY = /^(?:utm_.+|fbclid|gclid)$/i;
const SECRET_KEY =
  /(?:^|[_-])(?:token|key|secret|password|signature|auth)(?:$|[_-])/i;
const BLOCKED_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal)$/i;

export class UrlPolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "UrlPolicyError";
  }
}

const looksLikeObfuscatedIpv4 = (hostname: string): boolean => {
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(hostname)) return true;
  const parts = hostname.split(".");
  return (
    parts.length > 0 &&
    parts.every((part) => /^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(part)) &&
    parts.some(
      (part) =>
        part.startsWith("0x") || (part.length > 1 && part.startsWith("0")),
    )
  );
};

export const canonicalizeTarget = (input: string): URL => {
  const trimmed = input.trim();
  if (!trimmed) throw new UrlPolicyError("url_empty");
  if (trimmed.length > 2048) throw new UrlPolicyError("url_too_long");

  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    throw new UrlPolicyError("url_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new UrlPolicyError("scheme_blocked");
  if (url.username || url.password)
    throw new UrlPolicyError("credentials_blocked");
  if (url.hostname.length > 253) throw new UrlPolicyError("hostname_too_long");
  if (BLOCKED_HOST_SUFFIX.test(url.hostname))
    throw new UrlPolicyError("hostname_blocked");
  const numericCandidate = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(numericCandidate) !== 0 || looksLikeObfuscatedIpv4(numericCandidate))
    throw new UrlPolicyError("numeric_host_blocked");
  if (url.port && url.port !== "80" && url.port !== "443")
    throw new UrlPolicyError("port_blocked");

  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => SECRET_KEY.test(key)))
    throw new UrlPolicyError("secret_query_blocked");
  for (const key of keys)
    if (TRACKING_KEY.test(key)) url.searchParams.delete(key);

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  ) {
    url.port = "";
  }
  return url;
};

export const validateRedirect = (from: URL, location: string): URL => {
  let candidate: URL;
  try {
    candidate = canonicalizeTarget(new URL(location, from).toString());
  } catch (error) {
    if (error instanceof UrlPolicyError) throw error;
    throw new UrlPolicyError("redirect_invalid");
  }
  if (from.protocol === "https:" && candidate.protocol !== "https:")
    throw new UrlPolicyError("redirect_downgrade_blocked");
  return candidate;
};

export const sameOrigin = (left: URL, right: URL): boolean =>
  left.origin === right.origin;
