/**
 * Cookies read from a request and written onto a response, in the shape the
 * scanner has always sent them: the value percent-encoded, `Path=/` unless
 * another is named, and an `Expires` beside a non-zero `Max-Age`, so a browser
 * that reads only one of the two keeps the cookie as long.
 */

export type CookieOptions = Readonly<{
  path?: string;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
}>;

/**
 * The named cookie's value, decoded, or undefined when the request does not
 * carry it. Where a name is sent twice the last one counts, and a value that
 * cannot be decoded counts as not sent.
 */
export function readCookie(request: Request, name: string): string | undefined {
  let found: string | undefined;
  for (const pair of (request.headers.get("cookie") ?? "").split(/; */)) {
    if (pair === "") continue;
    const at = pair.indexOf("=");
    const key = at === -1 ? pair : pair.slice(0, at);
    if (key !== name) continue;
    try {
      found = at === -1 ? "true" : decodeURIComponent(pair.slice(at + 1));
    } catch {}
  }
  return found;
}

/** The `Set-Cookie` value that gives the browser `name` with `value`. */
export function cookieHeader(name: string, value: string, options: CookieOptions = {}): string {
  const { path = "/", maxAge, secure, httpOnly, sameSite } = options;
  const attributes = [
    `Path=${path}`,
    maxAge ? `Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}` : null,
    maxAge === undefined ? null : `Max-Age=${maxAge}`,
    secure ? "Secure" : null,
    httpOnly ? "HttpOnly" : null,
    sameSite ? `SameSite=${sameSite}` : null,
  ].filter((attribute) => attribute !== null);
  return [`${name}=${encodeURIComponent(value)}`, ...attributes].join("; ");
}
