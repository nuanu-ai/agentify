import type { DecisionMailEvent } from "./live-sales-events.js";
import type { Message } from "./mail.js";
import { transactionalEmailHtml } from "./mail-template.js";
import { momentInUtc } from "./moments.js";
import { stoppedOnOurSide } from "./shop-jobs.js";

/** The gallery and delivery worker use the same complete HTML. */
export function decisionMessage(parts: {
  readonly to: string;
  readonly event: DecisionMailEvent;
  readonly baseUrl: string;
  readonly idempotencyKey: string;
}): Message {
  const { event, baseUrl } = parts;
  const approved = event.kind === "admitted";
  const seller = event.sellerName;
  const approval =
    seller === null
      ? "Agentify approved your account for live sales."
      : `Agentify approved ${seller} for live sales.`;
  let subject = "You're approved for live sales on Agentify";
  let title = "You're approved for live sales";
  let lead = approved ? approval : "Your payout wallet is saved.";
  let paragraphs: string[] = [];
  let action = "Open your products";
  let link = baseUrl;
  if (event.kind === "withdrawn") {
    if (event.reason === null || event.reason.trim() === "")
      throw new Error("a withdrawal email needs its recorded note");
    subject = title = "Agentify stopped your live sales";
    lead = `Agentify stopped live sales${seller === null ? "" : ` for ${seller}`} on ${momentInUtc(new Date(event.at).toISOString())}.`;
    paragraphs = [
      "Your products don't sell until you're approved again. Orders already paid stay as they are.",
      `Note from Agentify:\n${event.reason}`,
      "Fix what the note asks, then ask again from your dashboard.",
    ];
    action = "Ask again in your dashboard";
  } else if (event.publication !== null) {
    const result = event.publication;
    const published = result.published.toLocaleString("en-US");
    const read = result.read.toLocaleString("en-US");
    const prefix = approved ? `${approval} ` : "";
    if (result.status === "completed" && result.published > 0) {
      subject = `${published} ${result.published === 1 ? "product was" : "products were"} published through Agentify`;
      title = approved
        ? "You're approved. We published your products"
        : "We published your products";
      lead = approved
        ? `${seller === null ? "Agentify approved your account" : `Agentify approved ${seller}`} for live sales, and we published ${published} ${result.published === 1 ? "product" : "products"} from ${result.host}.`
        : `We published ${published} ${result.published === 1 ? "product" : "products"} from ${result.host}.`;
      if (result.fix > 0)
        paragraphs.push(
          `${result.fix.toLocaleString("en-US")} more ${result.fix === 1 ? "product" : "products"} can go on sale once you fix ${result.fix === 1 ? "it" : "them"} in your shop.`,
        );
    } else if (result.status === "stopped" && result.read > 0) {
      subject = title = approved
        ? "You're approved. Publishing stopped partway"
        : "Publishing stopped partway";
      const progress =
        result.published === 0
          ? `No products from ${result.host} were confirmed for sale before the work stopped`
          : `We published ${published} ${result.published === 1 ? "product" : "products"} from ${result.host}`;
      lead = `${prefix}${progress}. Reading stopped after ${read}${result.total === null ? " products" : ` of ${result.total.toLocaleString("en-US")}`}. We don't know about the rest yet.`;
      paragraphs = ["Sync with your shop from your dashboard to publish the rest."];
    } else {
      subject = title = approved
        ? "You're approved. No products were confirmed for sale"
        : "No products were confirmed for sale";
      if (result.status === "stopped" && stoppedOnOurSide(result)) {
        subject = title = approved
          ? "You're approved. Publishing stopped on our side"
          : "Publishing stopped on our side";
        lead = `${prefix}Agentify stopped on its side before reading ${result.host}. Nothing was published.`;
        paragraphs = ["Sync with your shop from your dashboard."];
      } else if (result.status === "stopped" && result.stopCode === "unread") {
        subject = title = approved
          ? "You're approved. We couldn't read your shop"
          : "We couldn't read your shop";
        lead = `${prefix}We couldn't finish reading ${result.host}. We haven't confirmed any products on sale from this publication.`;
        paragraphs = ["We don't know about the rest yet. Sync with your shop from your dashboard."];
      } else {
        lead = `${prefix}When this publication finished, no products from ${result.host} were confirmed for sale.`;
        paragraphs = [
          result.why ?? "Open your products to see what needs to change before they can sell.",
        ];
      }
    }
    paragraphs.push(
      `Publication result recorded ${momentInUtc(new Date(result.at).toISOString())}.`,
    );
  } else if (event.next === "wallet") {
    title = "You're approved. Add your payout wallet.";
    paragraphs = [
      event.integration === "woocommerce"
        ? "Add the wallet where your share of each sale is paid, and we publish your ready products right away."
        : "Add the wallet where your share of each sale is paid, then publish your products from your code.",
    ];
    action = "Add payout wallet";
  } else if (event.next === "code") {
    paragraphs = ["Publish your products from your code."];
    action = "Open the publishing guide";
    link = `${new URL(baseUrl).origin}/docs/quickstart#_4-publish-one-card`;
  } else if (event.next === "settings") {
    paragraphs = ["Finish your seller name and site in Settings before publishing products."];
    action = "Open Settings";
    link = `${baseUrl}/settings`;
  } else if (event.next === "connect") {
    paragraphs = ["Connect your shop or code before publishing products."];
    action = "Open your connections";
    link = `${baseUrl}/integrations`;
  } else {
    paragraphs = ["Check your connected shop and exchange rate before publishing products."];
  }
  if (!approved && event.kind !== "withdrawn" && event.publication === null) {
    subject = title = "Your payout wallet is saved";
  }
  const reason = "You get this email because you have a seller account on Agentify.";
  return {
    to: parts.to,
    subject,
    body: ["Agentify", title, lead, ...paragraphs, `${action}:\n${link}`, reason].join("\n\n"),
    html: transactionalEmailHtml(
      {
        preview: lead,
        title,
        lead,
        paragraphs,
        action,
        link,
        reason,
      },
      { paragraphsBeforeAction: true },
    ),
    idempotencyKey: parts.idempotencyKey,
  };
}
