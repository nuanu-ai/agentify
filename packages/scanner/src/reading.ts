import type { FetchArtifact } from "./model.js";
import { parseSafeJson } from "./parsers.js";

/**
 * What one request for a document came to, before anything is concluded from
 * its content. An answer read whole speaks for the whole document. An answer
 * cut at the scanner's read limit speaks only for the part read, and carries
 * the limit so that the result can name it. A 404 or a 410 says the document
 * is not there. Any other outcome, from no answer at all to a server error, a
 * refusal or a rate limit, says nothing about the document.
 */
export type Reading =
  | Readonly<{ state: "whole"; artifact: FetchArtifact }>
  | Readonly<{ state: "cut"; artifact: FetchArtifact; readLimit: string }>
  | Readonly<{ state: "absent"; status: number }>
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
  if (status < 200 || status >= 300)
    return { state: "unread", errorCode: `http_${status}`, status };
  // A cut answer holds exactly the limit it was cut at.
  return artifact.truncated
    ? { state: "cut", artifact, readLimit: byteSize(artifact.decodedBytes) }
    : { state: "whole", artifact };
};

const opening = (body: string): string =>
  (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body).trimStart();

/**
 * Whether an answer is a web page: what a site that routes every address to
 * its application sends where a text document belongs. It is the site's way
 * of saying the document is not there.
 */
export const isWebPage = (body: string): boolean => {
  const start = opening(body.slice(0, 4096)).slice(0, 15).toLowerCase();
  return start.startsWith("<!doctype html") || /^<html[\s>]/.test(start);
};

/** A JSON discovery document as read: its object, or why there is none to judge. */
export type DocumentReading =
  | Readonly<{ state: "document"; value: Record<string, unknown> }>
  | Readonly<{ state: "malformed" }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "cut"; readLimit: string }>
  | Readonly<{ state: "unread"; errorCode: string; status?: number }>;

/**
 * An answer that does not open as a JSON object or array, a web page, a line
 * of text or nothing at all, is no document, whether it was read whole or cut.
 * One that does open as JSON is judged only when it was read whole, and is
 * malformed when it is not an object the scanner can parse.
 */
export const jsonDocumentOf = (
  artifact: FetchArtifact | undefined,
  unreadCode: string,
): DocumentReading => {
  const reading = readingOf(artifact, unreadCode);
  if (reading.state === "absent") return { state: "absent" };
  if (reading.state === "unread") return reading;
  const first = opening(reading.artifact.body.slice(0, 4096)).charAt(0);
  if (first !== "{" && first !== "[") return { state: "absent" };
  if (reading.state === "cut") return { state: "cut", readLimit: reading.readLimit };
  const value = parseSafeJson(opening(reading.artifact.body));
  return value && typeof value === "object" && !Array.isArray(value)
    ? { state: "document", value: value as Record<string, unknown> }
    : { state: "malformed" };
};
