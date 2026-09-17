/**
 * The two ways a message leaves the cabinet, and the one value that picks
 * between them.
 *
 * There is one kind of message: a one-time link that proves its reader owns an
 * address. It is short, it is sent because somebody just asked for it, and
 * nothing here ever sends anything nobody asked for.
 *
 * Which sender is in force is `MAIL_URL`, one variable with one value, the same
 * shape the gateway uses to pick its facilitator (`apps/gateway/src/config.ts`).
 * `sandbox:log` writes every message to the log with its recipient and its link,
 * so the whole flow walks on a laptop with no account, no domain and no network
 * — and a scheme nobody can reach means a typo is a refusal at start-up rather
 * than an address that quietly does not answer. Anything else is a provider,
 * which today means Resend.
 *
 * Nothing waits for delivery. A caller learns only whether the provider took
 * the message. Refusal is returned so the identity transaction can remove the
 * unusable token and the cabinet can answer with an honest retryable 503.
 * Delivery is a different question and this file cannot answer it: there is no
 * inbox here and no bounce handler.
 */

/**
 * The address that means nothing is sent anywhere.
 *
 * A scheme rather than a word, so that it cannot be mistaken for a host that is
 * merely unreachable, and so that the configuration refuses it in the one place
 * a real address is expected.
 */
export const SANDBOX_MAIL = "sandbox:log";

/** Whether this cabinet writes its messages to the log instead of sending them. */
export const isSandboxMail = (mailUrl: string): boolean => mailUrl === SANDBOX_MAIL;

/** One message, already written, with nothing left to decide about it. */
export interface Message {
  readonly to: string;
  readonly subject: string;
  /** Plain text for clients that do not render HTML and for the local log. */
  readonly body: string;
  /** Self-contained HTML with the same action and claims as the plain text. */
  readonly html: string;
}

/**
 * What became of one message at the door out.
 *
 * `"accepted"` is the provider taking it and nothing more. `"refused"` is
 * everything else: a provider that would not have it, a provider that did not
 * answer at all, and — where a caller passes this word further up — a call
 * where no message was ever handed over. Two words rather than three because
 * the one decision anybody makes on this is whether they may tell somebody a
 * link went out, and all of those say no.
 */
export type Handover = "accepted" | "refused";

/** How a message leaves, or is written down instead of leaving. */
export type Postman = (message: Message) => Promise<Handover>;

/** A provider call never holds an identity transaction beyond this deadline. */
const MAIL_PROVIDER_TIMEOUT_MS = 10_000;

/** What a sender needs to know about itself. */
export interface MailConfig {
  /** `sandbox:log`, or the address of a provider. */
  readonly mailUrl: string;
  /** The credential the provider is called with, or nothing in the sandbox. */
  readonly mailApiKey: string | null;
  /** What the message says it is from. */
  readonly mailFrom: string;
}

/**
 * The sender this configuration asks for.
 *
 * One function either way, so nothing above this file has a branch in it about
 * whether mail is real here. The cabinet's identity flow is the same code on a
 * laptop and on a server; only the sink that accepts the message changes.
 */
export function postmanFor(config: MailConfig): Postman {
  return isSandboxMail(config.mailUrl) ? toTheLog : throughResend(config);
}

/**
 * The sandbox sender: every message, whole, in the log.
 *
 * The link is printed as it stands rather than described, because the only
 * reason to read this is to follow it. Whoever is developing the cabinet copies
 * it out of their terminal, and that is the entire flow with no account
 * anywhere.
 *
 * Taken, and not refused for having gone nowhere. The log is the only sink
 * there is here, so the message reached everything a message can reach — and a
 * caller told otherwise would hide the note naming the address from the one
 * person who is about to go and look for the link.
 */
const toTheLog: Postman = async (message) => {
  console.log(
    `[cabinet] no mail provider is configured, so this message was not sent.` +
      ` To: ${message.to}. Subject: ${message.subject}.\n${message.body}`,
  );
  return "accepted";
};

/**
 * The provider sender.
 *
 * One call, one JSON document, and no reading of what comes back beyond whether
 * it worked. Nothing in the cabinet receives mail — there is no inbox, no bounce
 * handler and no reply address that reaches anybody — so the answer to this call
 * is only ever a line in a log.
 *
 * A failure is caught here rather than thrown at the caller. The caller needs
 * one stable refusal result so it can roll back the new token and tell the
 * person that sign-in is temporarily unavailable without exposing provider
 * details.
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
        },
        body: JSON.stringify({
          from: config.mailFrom,
          to: [message.to],
          subject: message.subject,
          text: message.body,
          html: message.html,
        }),
      });
      if (!answered.ok) {
        // The status and nothing else. What comes back can carry the address it
        // was refused for, and a log goes places the database does not.
        console.error(`[cabinet] mail provider refused a message (${answered.status})`);
        return "refused";
      }
      // The other half of the same sentence, and the reason it is here: every
      // caller of this carries on regardless, so this log is the only account
      // of what became of a message. With the refusals written down alone,
      // nothing distinguishes an address the provider took from an address
      // nobody ever asked about. "Handed to" and not "sent": there is no inbox
      // here and no bounce handler, so what the provider did with it after
      // this is not something this process ever learns.
      console.log("[cabinet] mail provider accepted a message");
      return "accepted";
    } catch {
      // The exception is deliberately not printed. A fetch implementation may
      // attach its request body, including the recipient and action URL.
      console.error("[cabinet] mail provider could not be reached");
      return "refused";
    }
  };
}
