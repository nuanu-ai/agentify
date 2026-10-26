import type { FetchArtifact } from "./model.js";
import { parseSafeJson } from "./parsers.js";

/**
 * What one request for a document came to, before anything is concluded from
 * its content. An answer read whole speaks for the whole document. An answer
 * cut at the scanner's read limit speaks only for the part read, and carries
 * the limit so that the result can name it. A 404 or a 410 says the document
 * is not there. Any other 4xx refuses it, and an agent asking is refused too,
 * so to an agent it is not there either. No answer at all, a timeout (408), a
 * rate limit (429) or a server error says nothing about the document.
 */
export type Reading =
  | Readonly<{ state: "whole"; artifact: FetchArtifact }>
  | Readonly<{ state: "cut"; artifact: FetchArtifact; readLimit: string }>
  | Readonly<{ state: "absent"; status: number }>
  | Readonly<{ state: "refused"; status: number }>
  | Readonly<{ state: "unread"; errorCode: string; status?: number }>;

const KIB = 1024;

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
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { state: "refused", status };
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
 * document is not there. A comment, a server warning or an XML prolog may
 * come before the page's own opening, so the first KiB is searched for it.
 */
export const isWebPage = (body: string): boolean => {
  const start = body.slice(0, KIB).toLowerCase();
  return start.includes("<!doctype html") || /<html[\s>]/.test(start);
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
 * A web page or an empty answer is no document, whether it was read whole or
 * cut. Anything else cut at the read limit is too large, a size that is known.
 * Anything else read whole is judged, and is malformed unless it parses to a
 * JSON object.
 */
export const jsonDocumentOf = (
  artifact: FetchArtifact | undefined,
  unreadCode: string,
): DocumentReading => {
  const reading = readingOf(artifact, unreadCode);
  if (reading.state === "absent") return { state: "absent" };
  if (reading.state === "refused" || reading.state === "unread") return reading;
  const { body } = reading.artifact;
  if (isWebPage(body) || body.trim() === "") return { state: "absent" };
  if (reading.state === "cut") return { state: "too_large", readLimit: reading.readLimit };
  // Trimming takes a byte order mark with the white space.
  const value = parseSafeJson(body.trim());
  return value && typeof value === "object" && !Array.isArray(value)
    ? { state: "document", value: value as Record<string, unknown> }
    : { state: "malformed" };
};
