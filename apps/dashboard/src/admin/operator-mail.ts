/**
 * The message every operator of a channel, and the account changed, receive
 * when the operator flag is granted or removed in the workspace, so a new
 * operator cannot appear without the others hearing of it. The change waits
 * for these mails, so a mail goes out before the change is kept, and a change
 * can still fail after it (another mail refused, the database failing): the
 * mail says the change applies only where Accounts shows it. Like the
 * dashboard's other notices it names what changed, when, and from which
 * session it was asked, never "you did this", since a stolen session is
 * signed in as its owner all the same; and its link only opens Accounts,
 * where nothing happens without signing in.
 */

import type { Message } from "../mail.js";
import { transactionalEmailHtml } from "../mail-template.js";
import { moment } from "../words.js";

export interface FlagChanged {
  /** The account whose flag changed. */
  readonly email: string;
  readonly granted: boolean;
  readonly at: Date;
  /** The address of the session the change was pressed from. */
  readonly askedBy: string;
  /** "production", "test environment" or "sandbox", with the channel's host and chain. */
  readonly channel: string;
  /** The workspace's Accounts page. */
  readonly accounts: string;
}

export function operatorFlagMessage(to: string, changed: FlagChanged): Message {
  const title = changed.granted
    ? "An operator is being added"
    : "An operator flag is being removed";
  const when = moment(changed.at.toISOString());
  const lead = changed.granted
    ? `${changed.email} is being made an operator of Agentify's ${changed.channel}, asked at ${when}. An operator reads every merchant, order and account of the channel, and can admit and stop merchants and change who else is an operator.`
    : `The operator flag of ${changed.email} on Agentify's ${changed.channel} is being removed, asked at ${when}. The operator's workspace closes to that account from its next request.`;
  const applies = `It applies only if Accounts in the workspace shows it: this message is sent before the change is kept, and the change is not made if a message to another operator is refused.`;
  const asked = `It was asked for in the operator's workspace, from a session signed in as ${changed.askedBy}.`;
  const unasked =
    "If no operator of this channel meant this, an operator who signs in afresh can change it back in Accounts and end every session of the account that asked. Every change of the flag is kept in the journal.";
  const inert = "This message opens nothing by itself: sign in the usual way.";
  const action = "Open Accounts";
  return {
    to,
    subject: changed.granted
      ? `An operator is being added on Agentify's ${changed.channel}`
      : `An operator flag is being removed on Agentify's ${changed.channel}`,
    body: `Agentify\n\n${title}\n\n${lead}\n\n${applies}\n\n${asked}\n\n${unasked}\n\n${inert}\n\n${action}:\n\n${changed.accounts}`,
    html: transactionalEmailHtml({
      preview: lead,
      eyebrow: "Operator's workspace",
      title,
      lead,
      action,
      link: changed.accounts,
      paragraphs: [applies, asked, unasked, inert],
      reason: "This message was sent because this address is an operator's, or its flag changed.",
    }),
  };
}
