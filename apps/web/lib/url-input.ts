export type UrlSyntaxResult =
  | Readonly<{
      ok: true;
      normalized: string;
      submittedWithoutScheme: boolean;
    }>
  | Readonly<{ ok: false; message: string }>;

const SENSITIVE_QUERY_KEY = /(token|key|secret|password|signature|auth)/i;

export function validateSubmittedUrl(value: string): UrlSyntaxResult {
  const input = value.trim();
  if (!input)
    return { ok: false, message: "Enter a domain or public website URL." };
  if (input.length > 2048)
    return { ok: false, message: "The URL is too long." };

  let parsed: URL;
  try {
    const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(input);
    parsed = new URL(explicitScheme ? input : `https://${input}`);
  } catch {
    return { ok: false, message: "Enter a domain such as example.com." };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      ok: false,
      message: "Only public HTTP or HTTPS URLs can be scanned.",
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      message: "Remove the username or password from this URL.",
    };
  }
  if (
    !parsed.hostname ||
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".local")
  ) {
    return { ok: false, message: "Enter a public website domain." };
  }
  if (parsed.port && !["80", "443"].includes(parsed.port)) {
    return {
      ok: false,
      message: "Only standard web ports 80 and 443 are supported.",
    };
  }
  if (
    [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))
  ) {
    return {
      ok: false,
      message: "Remove secret or authentication parameters before scanning.",
    };
  }

  parsed.hash = "";
  return {
    ok: true,
    normalized: parsed.toString(),
    submittedWithoutScheme: !/^[a-z][a-z\d+.-]*:/i.test(input),
  };
}
