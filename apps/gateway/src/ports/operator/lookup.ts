/**
 * What a text pasted into the lookup is, read from its shape alone: the
 * identifiers carry their kind in their prefix, a transaction and an address
 * their length, and a site is whatever reads as a web address. Both readers
 * search by this, so they cannot disagree about what was asked.
 */

export type Lookup =
  | { readonly kind: "order"; readonly id: string }
  | { readonly kind: "merchant"; readonly id: string }
  | { readonly kind: "transaction"; readonly hash: string }
  | { readonly kind: "address"; readonly address: string }
  /** The site's origin, `https://` and the host in lower case, as a seller's site is kept. */
  | { readonly kind: "site"; readonly origin: string }
  /** An email address: the dashboard's accounts answer it, and nothing here does. */
  | { readonly kind: "email"; readonly address: string }
  /** A text that names nothing this lookup reads. */
  | { readonly kind: "none" };

const TRANSACTION = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** An address with one @, a name before it and a dotted domain after it, and no slash. */
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;
/** A host as a seller's site can name one: labels of letters, digits and hyphens. */
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d+)?$/;

export function lookupOf(text: string): Lookup {
  const pasted = text.trim();
  if (pasted === "") return { kind: "none" };
  if (EMAIL.test(pasted)) return { kind: "email", address: pasted };
  if (pasted.startsWith("ord_")) {
    return IDENTIFIER.test(pasted) ? { kind: "order", id: pasted } : { kind: "none" };
  }
  if (pasted.startsWith("mch_")) {
    return IDENTIFIER.test(pasted) ? { kind: "merchant", id: pasted } : { kind: "none" };
  }
  if (TRANSACTION.test(pasted)) return { kind: "transaction", hash: pasted.toLowerCase() };
  if (ADDRESS.test(pasted)) return { kind: "address", address: pasted.toLowerCase() };
  return siteOf(pasted);
}

/**
 * The origin of a pasted site, with or without its scheme and with any path,
 * read as `https`, the only scheme a seller's site may have.
 */
function siteOf(pasted: string): Lookup {
  const written = /^[a-z][a-z0-9+.-]*:\/\//i.test(pasted) ? pasted : `https://${pasted}`;
  let url: URL;
  try {
    url = new URL(written);
  } catch {
    return { kind: "none" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "none" };
  if (!HOST.test(url.host) || !url.hostname.includes(".")) return { kind: "none" };
  return { kind: "site", origin: `https://${url.host}` };
}
