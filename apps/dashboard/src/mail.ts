/**
 * `MAIL_URL` picks the sender: `sandbox:log` writes every message, link
 * included, to the log, and anything else is a provider (Resend). Nothing waits
 * for delivery: a caller learns whether the provider took the message, refused
 * it, or left that unknown, and anything but taken lets the identity
 * transaction remove the unusable token and answer with a retryable 503.
 */

/**
 * A scheme rather than a word, so it cannot be mistaken for a host that is
 * merely unreachable.
 */
export const SANDBOX_MAIL = "sandbox:log";

export const isSandboxMail = (mailUrl: string): boolean => mailUrl === SANDBOX_MAIL;

/** A file sent with a message; `content` is its text, sent as UTF-8. */
interface Attachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: string;
}

export interface Message {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly html: string;
  readonly attachments?: readonly Attachment[];
  /**
   * Names one message across tries: the provider sends a repeat carrying the
   * same key and the same message once, within a day of the first.
   */
  readonly idempotencyKey?: string;
}

const bytesOf = (attachment: Attachment): number => Buffer.byteLength(attachment.content, "utf8");

/**
 * What became of a message handed to the provider. `"accepted"` is the
 * provider taking it and nothing more; `"refused"` is a clear answer that it
 * did not; `"unknown"` is no answer, a failure on the provider's side, or a
 * repeat of a key whose first message may have gone. A caller that may only
 * say a message went out when it did treats both of the others alike; one that
 * tells somebody what happened keeps them apart.
 */
export type Handover = "accepted" | "refused" | "unknown";

export type Postman = (message: Message) => Promise<Handover>;

/** A provider call never holds an identity transaction beyond this deadline. */
const MAIL_PROVIDER_TIMEOUT_MS = 10_000;

export interface MailConfig {
  readonly mailUrl: string;
  readonly mailApiKey: string | null;
  readonly mailFrom: string;
}

export function postmanFor(config: MailConfig): Postman {
  return isSandboxMail(config.mailUrl) ? toTheLog : throughResend(config);
}

/**
 * The link is printed whole, because following it is the only reason to read
 * this. Taken rather than refused: the log is the only sink here, and a caller
 * told otherwise would hide the note naming the address from the person about
 * to look for the link. An attachment is named and never printed: it is a
 * person's copy of their own data.
 */
const toTheLog: Postman = async (message) => {
  const attached = (message.attachments ?? [])
    .map(
      (attachment) =>
        `\nAttached, not printed: ${attachment.filename}, ${bytesOf(attachment)} bytes.`,
    )
    .join("");
  console.log(
    `[dashboard] no mail provider is configured, so this message was not sent.` +
      ` To: ${message.to}. Subject: ${message.subject}.\n${message.body}${attached}`,
  );
  return "accepted";
};

/**
 * A failure is caught here rather than thrown, so the caller gets a refusal
 * or an unknown outcome, never an exception, and can roll back the token
 * without exposing provider details.
 */
function throughResend(config: MailConfig): Postman {
  return async (message) => {
    try {
      const answered = await fetch(`${config.mailUrl}/emails`, {
        method: "POST",
        signal: AbortSignal.timeout(MAIL_PROVIDER_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${config.mailApiKey ?? ""}`,
          "content-type": "application/json",
          ...(message.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": message.idempotencyKey }),
        },
        body: JSON.stringify({
          from: config.mailFrom,
          to: [message.to],
          subject: message.subject,
          text: message.body,
          html: message.html,
          ...(message.attachments === undefined
            ? {}
            : {
                attachments: message.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  content: Buffer.from(attachment.content, "utf8").toString("base64"),
                  content_type: attachment.contentType,
                })),
              }),
        }),
      });
      if (!answered.ok) {
        // The status and nothing else: the body can carry the recipient's
        // address, and a log goes places the database does not.
        const told = answered.status === 409 || answered.status >= 500;
        console.error(
          told
            ? `[dashboard] mail provider answered a message with ${answered.status}; whether it went is not known`
            : `[dashboard] mail provider refused a message (${answered.status})`,
        );
        return told ? "unknown" : "refused";
      }
      // Every caller carries on regardless, so this log is the only account of
      // what became of a message. "Accepted", not "sent": what the provider
      // does after this is never learned here.
      console.log("[dashboard] mail provider accepted a message");
      return "accepted";
    } catch {
      // Not printed: a fetch implementation may attach the request body,
      // including the recipient and the link.
      console.error("[dashboard] mail provider could not be reached");
      return "unknown";
    }
  };
}
