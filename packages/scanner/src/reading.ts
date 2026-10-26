import type { FetchArtifact } from "./model.js";
import { parseSafeJson } from "./parsers.js";

/**
 * What one request for a document came to, before anything is concluded from
 * its content. An answer read whole speaks for the whole document. An answer
 * cut at the scanner's read limit speaks only for the part read, and carries
 * the limit so that the result can name it. A 404 or a 410 says the document
 * is not there. Any other 4xx refuses it, and an agent asking is refused too,
 * so to an agent it is not there either. No answer at all, a timeout (408), a
 * rate limit (429), a refusal of the scanner's own request headers (431), a
 * block that depends on where the scanner asks from (451) or a server error
 * says nothing about the document.
 */
export type Reading =
  | Readonly<{ state: "whole"; artifact: FetchArtifact }>
  | Readonly<{ state: "cut"; artifact: FetchArtifact; readLimit: string }>
  | Readonly<{ state: "absent"; status: number }>
  | Readonly<{ state: "refused"; status: number }>
  | Readonly<{ state: "unread"; errorCode: string; status?: number }>;

const KIB = 1024;
const UNREAD_4XX = new Set([408, 429, 431, 451]);

/** A byte count in the binary units the scanner's read limits are set in. */
export const byteSize = (bytes: number): string => {
  if (bytes >= KIB * KIB && bytes % (KIB * KIB) === 0) return `${bytes / (KIB * KIB)} MiB`;
  if (bytes >= KIB && bytes % KIB === 0) return `${bytes / KIB} KiB`;
  return `${bytes} bytes`;
};

/** `unreadCode` names the reason when nothing at all was asked for. */
export const readingOf = (artifact: FetchArtifact | undefined, unreadCode: string): Reading => {
  if (!artifact) return { state: "unread", errorCode: unreadCode };
  const { status } = artifact;
  if (artifact.errorCode || status === 0)
    return {
      state: "unread",
      errorCode: artifact.errorCode ?? unreadCode,
      ...(status ? { status } : {}),
    };
  if (status === 404 || status === 410) return { state: "absent", status };
  if (status >= 400 && status < 500 && !UNREAD_4XX.has(status)) return { state: "refused", status };
  if (status < 200 || status >= 300)
    return { state: "unread", errorCode: `http_${status}`, status };
  // A cut answer holds exactly the limit it was cut at.
  return artifact.truncated
    ? { state: "cut", artifact, readLimit: byteSize(artifact.decodedBytes) }
    : { state: "whole", artifact };
};

/**
 * Whether an answer is a web page: what a site that routes every address to
 * its application sends where a document belongs, and its way of saying the
 * document is not there. The page's opening is looked for past white space,
 * comments and an XML prolog, and nowhere else, so a document that only
 * mentions a page's markup is not taken for one.
 */
export const isWebPage = (body: string): boolean => {
  let rest = body.slice(0, 4 * KIB).trimStart();
  for (;;) {
    const close = rest.startsWith("<!--") ? "-->" : rest.startsWith("<?xml") ? "?>" : undefined;
    const end = close ? rest.indexOf(close) : -1;
    if (!close || end === -1) break;
    rest = rest.slice(end + close.length).trimStart();
  }
  const opening = rest.slice(0, 15).toLowerCase();
  return opening.startsWith("<!doctype html") || /^<html[\s>]/.test(opening);
};

/** A JSON discovery document as read: its object, or why there is none to judge. */
export type DocumentReading =
  | Readonly<{ state: "document"; value: Record<string, unknown> }>
  | Readonly<{ state: "malformed" }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "refused"; status: number }>
  | Readonly<{ state: "too_large"; readLimit: string }>
  | Readonly<{ state: "unread"; errorCode: string; status?: number }>;

/**
 * An answer read whole that parses to a JSON object is the document. One that
 * does not is no document when it is empty or a web page, and malformed
 * otherwise. An answer cut at the read limit is no document when it opens as
 * a web page, and too large otherwise, a size that is known.
 */
export const jsonDocumentOf = (
  artifact: FetchArtifact | undefined,
  unreadCode: string,
): DocumentReading => {
  const reading = readingOf(artifact, unreadCode);
  if (reading.state === "absent") return { state: "absent" };
  if (reading.state === "refused" || reading.state === "unread") return reading;
  const { body } = reading.artifact;
  if (reading.state === "cut")
    return isWebPage(body)
      ? { state: "absent" }
      : { state: "too_large", readLimit: reading.readLimit };
  // Trimming takes a byte order mark with the white space.
  const value = parseSafeJson(body.trim());
  if (value && typeof value === "object" && !Array.isArray(value))
    return { state: "document", value: value as Record<string, unknown> };
  return body.trim() === "" || isWebPage(body) ? { state: "absent" } : { state: "malformed" };
};
