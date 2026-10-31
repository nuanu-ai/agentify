/** The connection outcomes shown in the gallery and exercised through the callback. */
export const WOO_SITE_CASES = [
  {
    id: "empty",
    before: null,
    writeFails: false,
    after: "https://shop.example.com",
    when: "A merchant returns after approving access to a shop and has not set a seller site.",
    cause: "The confirmed shop origin fills the empty seller site.",
  },
  {
    id: "chosen",
    before: "https://seller.example",
    writeFails: false,
    after: "https://seller.example",
    when: "A merchant connects a shop after setting a different seller site in Settings.",
    cause: "Connecting a shop leaves the seller's existing site unchanged.",
  },
  {
    id: "retry",
    before: null,
    writeFails: true,
    after: null,
    when: "A merchant returns after approving shop access, but the seller site could not be saved.",
    cause:
      "The shop remains connected; the merchant can retry saving its origin without typing it.",
  },
] as const;
