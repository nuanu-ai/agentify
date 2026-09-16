import {
  createLogger,
  safeErrorCode,
  safeErrorType,
} from "@agentify/observability";
import { Resend } from "resend";

import { getServerConfig } from "./config";

type TransactionalEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  evidenceUrl?: string;
};

let localEvidence: TransactionalEmail | undefined;
const logger = createLogger({
  service: "web",
  environment: process.env.NODE_ENV ?? "development",
});

export async function sendTransactionalEmail(
  email: TransactionalEmail,
): Promise<void> {
  const config = getServerConfig();
  if (config.EMAIL_PROVIDER === "local") {
    localEvidence = email;
    return;
  }
  if (config.EMAIL_PROVIDER === "disabled")
    throw new Error("email_provider_disabled");
  const resend = new Resend(config.RESEND_API_KEY);
  const result = await resend.emails.send({
    from: resendSender(config.RESEND_FROM),
    to: email.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  if (result.error)
    throw new Error(`resend_delivery_failed:${result.error.name}`);
}

function resendSender(address: string): string {
  return `Agentify <${address}>`;
}

export async function trySendTransactionalEmail(
  email: TransactionalEmail,
  sender: (
    message: TransactionalEmail,
  ) => Promise<void> = sendTransactionalEmail,
): Promise<boolean> {
  try {
    await sender(email);
    return true;
  } catch (error) {
    logger.error("transactional_email_delivery_failed", {
      error_type: safeErrorType(error),
      error_code: safeErrorCode(error),
    });
    // Report access was already committed. Delivery monitoring/retry may alert,
    // but an optional follow-up email must never consume the one-time link
    // without issuing the verified browser session.
    return false;
  }
}

export function getLocalEmailEvidence(): TransactionalEmail | undefined {
  if (getServerConfig().production) return undefined;
  return localEvidence;
}
