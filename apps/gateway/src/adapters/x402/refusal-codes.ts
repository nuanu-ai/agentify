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
 * Codes that are a verdict on the payment, by its kind. A different price,
 * asset, chain or payee is caught by the gateway's own comparison before the
 * facilitator is asked, so a code about the authorised value or recipient
 * means the payer signed something other than the offer it names, and signing
 * the offer again cures it. That is also why no code here means `price_stale`.
 */
const VERDICTS: Readonly<
  Record<Exclude<PaymentVerificationFailure, "price_stale" | "unrecognised">, readonly string[]>
> = {
  signature: [
    "invalid_payload",
    "invalid_scheme",
    "invalid_network",
    "invalid_x402_version",
    "unsupported_payload_type",
    "invalid_exact_evm_scheme",
    "invalid_exact_evm_unsupported_scheme",
    "invalid_exact_evm_network_mismatch",
    "invalid_exact_evm_payload",
    "invalid_exact_evm_payload_missing_signature",
    "invalid_exact_evm_payload_signature",
    "invalid_exact_evm_payload_signature_address",
    "invalid_exact_evm_signature",
    "invalid_exact_evm_signature_format",
    "invalid_exact_evm_failed_to_parse_signature",
    "invalid_exact_evm_payload_authorization_typed_data_message",
    "invalid_exact_evm_payload_authorization_valid_after",
    "invalid_exact_evm_payload_authorization_valid_before",
    "invalid_exact_evm_payload_authorization_value",
    "invalid_exact_evm_payload_authorization_value_mismatch",
    "invalid_exact_evm_payload_authorization_value_too_low",
    "invalid_exact_evm_authorization_value",
    "invalid_exact_evm_payload_recipient_mismatch",
    "invalid_exact_evm_recipient_mismatch",
    "invalid_exact_evm_nonce_already_used",
    "duplicate_settlement",
  ],
  insufficient_funds: [
    "insufficient_funds",
    "invalid_exact_evm_insufficient_balance",
    "invalid_exact_evm_insufficient_funds",
  ],
  // The order's own amount is what the payment network turns away, so a new
  // signature or a new purchase at the same price meets the same answer.
  amount_not_payable: ["amount_too_low", "invalid_amount", "invalid_exact_evm_required_amount"],
  wallet_refused: [
    "kyt_risk_detected",
    "invalid_exact_evm_payload_authorization_from_address_kyt",
    "self_send_not_allowed",
    "invalid_exact_evm_payload_undeployed_smart_wallet",
    "eip6492_factory_not_allowed",
    "smart_wallet_deployment_failed",
  ],
  // A transfer that failed in simulation or on the chain may have failed for
  // want of funds, a used authorization or a bad signature, and these codes do
  // not say which.
  unexplained: [
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
 * Codes sent in a refusal that are no verdict on the payment. They report the
 * facilitator's own failure to read the chain, a refusal of the terms Agentify
 * asked it to check (terms the payer did not write), or a refusal of where the
 * seller is paid.
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
    ],
    refused_agentify: [
      "request_blocked_by_location",
      "invalid_payment_requirements",
      "invalid_bazaar_extension",
      "invalid_exact_evm_extra_field",
      "invalid_exact_evm_missing_eip712_domain",
      "invalid_exact_evm_eip3009_not_supported",
      "invalid_exact_evm_token_name_mismatch",
      "invalid_exact_evm_token_version_mismatch",
      "asset_not_deployed_contract",
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
