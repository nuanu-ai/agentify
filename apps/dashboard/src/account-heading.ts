import type { AccountReason } from "./words.js";

const KEEP_OFF_SALE: ReadonlySet<AccountReason> = new Set([
  "paused",
  "no_seller_name",
  "no_payout_wallet",
  "not_approved",
  "out_of_touch",
]);

/**
 * The banner's heading. One reason is headed by its own title; several by
 * what they come to together where one of them keeps every product off sale,
 * otherwise by the refused purchases where they hold, since those refuse every
 * product, and otherwise by the first.
 * Here rather than beside the reasons, so the page's script that draws the
 * banner does not carry the rules that find them.
 */
export const headingOf = (
  notes: readonly Readonly<{ reason: AccountReason; title: string }>[],
): string => {
  const [first] = notes;
  if (first === undefined) return "";
  if (notes.length === 1) return first.title;
  if (notes.some((note) => KEEP_OFF_SALE.has(note.reason))) return "Your products are off sale";
  return (notes.find((note) => note.reason === "unserved") ?? first).title;
};
