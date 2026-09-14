type MediaPreference = Readonly<{
  mediaType: string;
  quality: number;
  order: number;
}>;

function parseAccept(value: string): MediaPreference[] {
  return value
    .split(",")
    .map((entry, order) => {
      const [rawMediaType, ...parameters] = entry.split(";");
      const mediaType = rawMediaType?.trim().toLowerCase() ?? "";
      let quality = 1;
      for (const parameter of parameters) {
        const [rawName, rawValue] = parameter.split("=");
        if (rawName?.trim().toLowerCase() !== "q") continue;
        const parsed = Number(rawValue?.trim());
        quality = Number.isFinite(parsed)
          ? Math.max(0, Math.min(1, parsed))
          : 0;
      }
      return { mediaType, quality, order };
    })
    .filter((entry) => entry.mediaType.length > 0);
}

function qualityFor(
  entries: readonly MediaPreference[],
  mediaType: "text/html" | "text/markdown",
): Readonly<{ quality: number; explicit: boolean; order: number }> {
  const exact = entries.find((entry) => entry.mediaType === mediaType);
  if (exact)
    return { quality: exact.quality, explicit: true, order: exact.order };
  const typeWildcard = entries.find((entry) => entry.mediaType === "text/*");
  if (typeWildcard)
    return {
      quality: typeWildcard.quality,
      explicit: false,
      order: typeWildcard.order,
    };
  const wildcard = entries.find((entry) => entry.mediaType === "*/*");
  return wildcard
    ? { quality: wildcard.quality, explicit: false, order: wildcard.order }
    : { quality: 0, explicit: false, order: Number.MAX_SAFE_INTEGER };
}

export function prefersMarkdown(acceptHeader: string | null): boolean {
  if (!acceptHeader) return false;
  const entries = parseAccept(acceptHeader);
  const markdown = qualityFor(entries, "text/markdown");
  const html = qualityFor(entries, "text/html");
  if (!markdown.explicit || markdown.quality <= 0) return false;
  if (html.quality <= 0) return true;
  if (markdown.quality !== html.quality) return markdown.quality > html.quality;
  return markdown.order <= html.order;
}

export function isReactServerComponentRequest(headers: Headers): boolean {
  return (
    headers.get("rsc") === "1" ||
    headers.has("next-router-state-tree") ||
    headers.has("next-router-prefetch") ||
    headers.get("purpose")?.toLowerCase() === "prefetch" ||
    headers.get("x-middleware-prefetch") === "1"
  );
}

export function appendVary(current: string | null, value: string): string {
  const values = new Map<string, string>();
  for (const entry of `${current ?? ""},${value}`.split(",")) {
    const normalized = entry.trim();
    if (normalized) values.set(normalized.toLowerCase(), normalized);
  }
  return [...values.values()].join(", ");
}
