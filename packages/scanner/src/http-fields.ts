// Readers for the HTTP header values the checks act on, each by the syntax
// HTTP gives that header.

/**
 * The elements of a header that carries a comma-separated list, trimmed, with
 * the empty elements HTTP allows dropped. A comma inside a quoted string stays
 * in its element.
 */
const headerList = (value: string | undefined): string[] => {
  const text = value ?? "";
  const elements: string[] = [];
  let element = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text.charAt(at);
    if (quoted && character === "\\") {
      element += character + text.charAt(at + 1);
      at += 1;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (character === "," && !quoted) {
      elements.push(element.trim());
      element = "";
      continue;
    }
    element += character;
  }
  elements.push(element.trim());
  return elements.filter(Boolean);
};

/** The field names a Vary header lists, lower-cased, `*` among them when it is there. */
export const varyNames = (value: string | undefined): string[] =>
  headerList(value).map((name) => name.toLowerCase());

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?=\s|$)/;

/**
 * The authentication schemes a WWW-Authenticate header challenges with,
 * lower-cased. An element that begins with a name and `=` is a parameter of
 * the challenge before it, not a scheme.
 */
export const authSchemes = (value: string | undefined): string[] =>
  headerList(value).flatMap((element) => {
    const scheme = TOKEN.exec(element)?.[0];
    return scheme ? [scheme.toLowerCase()] : [];
  });

/** The media type of a Content-Type header, without its parameters, lower-cased. */
export const mediaType = (value: string | undefined): string =>
  (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
