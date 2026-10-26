/**
 * What a facilitator's refusal of a payment means, read from its code as a
 * whole. The codes are the vocabulary of Coinbase's hosted facilitator and of
 * the reference facilitator in the x402 libraries. Only the codes that can
 * describe an exact payment on an EVM chain by a signed transfer authorization
 * are listed, since that is the one payment this gateway offers and a payment
 * of any other kind is refused before a facilitator is asked.
 *
 * A code missing from this table is `unrecognised`. It is never matched to a
 * similar-looking code, because the buyer acts on the next step its kind
 * names.
 */

import type { PaymentVerificationFailure } from "@agentify/core";
import type { NoVerdict } from "../../ports/facilitator.js";

export type RefusalReading =
  | { readonly refused: PaymentVerificationFailure }
  | { readonly noVerdict: NoVerdict };

/**
 * Codes that are a verdict on the payment, by its kind. Before a facilitator
 * is asked, the gateway compares the price, asset, chain, payee, scheme and
 * protocol version with the offer, and the signed value and recipient with the
 * order. So `signature` holds only what that comparison cannot see: the
 * signature itself, its validity window and whether its nonce was used. No
 * code here means `price_stale`.
 */
const VERDICTS: Readonly<
  Record<Exclude<PaymentVerificationFailure, "price_stale" | "unrecognised">, readonly string[]>
> = {
  signature: [
    "invalid_exact_evm_payload_missing_signature",
    "invalid_exact_evm_payload_signature",
    "invalid_exact_evm_payload_signature_address",
    "invalid_exact_evm_signature",
    "invalid_exact_evm_signature_format",
    "invalid_exact_evm_failed_to_parse_signature",
    "invalid_exact_evm_payload_authorization_typed_data_message",
    "invalid_exact_evm_payload_authorization_valid_after",
    "invalid_exact_evm_payload_authorization_valid_before",
    "invalid_exact_evm_nonce_already_used",
    "duplicate_settlement",
  ],
  insufficient_funds: [
    "insufficient_funds",
    "invalid_exact_evm_insufficient_balance",
    "invalid_exact_evm_insufficient_funds",
  ],
  // The order's own amount is what the payment network turns away, so a new
  // signature or a new purchase at the same price meets the same answer. The
  // signed value has been checked to equal the price, so a value too low is
  // the price too low.
  amount_not_payable: [
    "amount_too_low",
    "invalid_amount",
    "invalid_exact_evm_required_amount",
    "invalid_exact_evm_payload_authorization_value_too_low",
  ],
  // The payment network refused the paying wallet as it stands: its own risk
  // screening of that wallet, a payment to itself, a smart wallet that is not
  // deployed or cannot be.
  wallet_refused: [
    "invalid_exact_evm_payload_authorization_from_address_kyt",
    "self_send_not_allowed",
    "invalid_exact_evm_payload_undeployed_smart_wallet",
    "eip6492_factory_not_allowed",
    "smart_wallet_deployment_failed",
  ],
  // A transfer that failed in simulation or on the chain may have failed for
  // want of funds, a used authorization or a bad signature, and these codes do
  // not say which. A generic invalid payload names no part of it, and risk
  // screening without an address names neither the payer's wallet nor the
  // seller's.
  unexplained: [
    "invalid_payload",
    "invalid_exact_evm_payload",
    "kyt_risk_detected",
    "invalid_exact_evm_verification_failed",
    "invalid_exact_evm_transaction_simulation_failed",
    "invalid_exact_evm_transaction_failed",
    "invalid_exact_evm_failed_to_execute_transfer",
    "invalid_exact_evm_transfer_event_mismatch",
    "invalid_transaction_state",
    "invalid_exact_evm_transaction_state",
    "preflight_validation_failed",
    "settlement_pending",
  ],
};

/**
 * Codes sent in a refusal that are no verdict on the payment.
 *
 * The `failed_to_` codes name a step the facilitator could not carry out,
 * beside separate codes for the bad answer that step looks for
 * (`invalid_exact_evm_signature` beside `failed_to_verify_signature`,
 * `insufficient_balance` beside `failed_to_get_balance`), so they are read as
 * its own failure. Only Coinbase's SDK names them and no source says more.
 * The reference facilitator gives `eip3009_not_supported` when its own read
 * of the token's authorization state fails, and the token is always USDC.
 *
 * The rest refuse terms Agentify wrote: what it asked the facilitator to
 * check, terms it compared the payment against before asking, the place it
 * asked from, and where the seller is paid.
 */
const NOT_VERDICTS: Readonly<Record<Exclude<NoVerdict, "payer_contradicted">, readonly string[]>> =
  {
    no_answer: [
      "unknown_error",
      "invalid_exact_evm_failed_to_check_nonce",
      "invalid_exact_evm_failed_to_get_balance",
      "invalid_exact_evm_failed_to_get_network_config",
      "invalid_exact_evm_failed_to_check_deployment",
      "invalid_exact_evm_failed_to_get_receipt",
      "invalid_exact_evm_failed_to_verify_signature",
      "invalid_exact_evm_eip3009_not_supported",
    ],
    refused_agentify: [
      "request_blocked_by_location",
      "invalid_payment_requirements",
      "invalid_bazaar_extension",
      "invalid_exact_evm_extra_field",
      "invalid_exact_evm_missing_eip712_domain",
      "invalid_exact_evm_token_name_mismatch",
      "invalid_exact_evm_token_version_mismatch",
      "asset_not_deployed_contract",
      "invalid_scheme",
      "invalid_network",
      "invalid_x402_version",
      "unsupported_payload_type",
      "invalid_exact_evm_scheme",
      "invalid_exact_evm_unsupported_scheme",
      "invalid_exact_evm_network_mismatch",
      "invalid_exact_evm_payload_authorization_value",
      "invalid_exact_evm_payload_authorization_value_mismatch",
      "invalid_exact_evm_authorization_value",
      "invalid_exact_evm_payload_recipient_mismatch",
      "invalid_exact_evm_recipient_mismatch",
    ],
    seller_cannot_be_paid: ["invalid_exact_evm_payload_authorization_to_address_kyt"],
  };

const BY_CODE: ReadonlyMap<string, RefusalReading> = (() => {
  const read = new Map<string, RefusalReading>();
  const put = (code: string, reading: RefusalReading) => {
    if (read.has(code)) throw new Error(`the refusal code ${code} is given two meanings`);
    read.set(code, reading);
  };
  for (const [refused, codes] of Object.entries(VERDICTS)) {
    for (const code of codes) put(code, { refused: refused as PaymentVerificationFailure });
  }
  for (const [noVerdict, codes] of Object.entries(NOT_VERDICTS)) {
    for (const code of codes) put(code, { noVerdict: noVerdict as NoVerdict });
  }
  return read;
})();

/** What the refusal code `code` means; a refusal with no code named no fault. */
export function readRefusal(code: string | undefined): RefusalReading {
  if (code === undefined || code === "") return { refused: "unexplained" };
  return BY_CODE.get(code) ?? { refused: "unrecognised" };
}
