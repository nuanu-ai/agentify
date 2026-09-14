export const CARD_SIGNAL_DISCLOSURES = [
  "No order is created",
  "Nothing will be charged automatically",
  "Any future purchase requires a separate explicit order and confirmation",
  "You can remove the card now",
] as const;

export function canLoadStripeSdk(input: {
  consented: boolean;
  clientSecret: string | undefined;
  adapter: "local" | "stripe";
  publishableKey: string | null;
}) {
  return Boolean(
    input.consented &&
    input.clientSecret &&
    input.adapter === "stripe" &&
    input.publishableKey,
  );
}
