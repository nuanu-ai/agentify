# ENG05: empty-wallet refusal on TEST

Date: 2026-10-27. The reported instruction to sign again with an empty wallet
is not reproduced on TEST runtime `90a445c68ad6a8c9f5481678b97be0e592ee6983`.
The payment adapter and gateway match those on main at `a1fbdf1b`.

An independently generated Base Sepolia wallet has zero USDC before and after
the check. A separate test merchant publishes the existing gift-message file
at 0.01 test USDC and runs a compatible SDK worker. Its identity, API key and
payout wallet use internal test setup; this does not test merchant signup.
The buyer uses the official x402 client with a 0.01 per-payment cap. No funded
buyer's private key is used and no USDC moves.

| Case | Observed response | Payment and delivery |
| --- | --- | --- |
| Empty wallet, honest signature | HTTP 409, `payment_not_verified`, facilitator code `invalid_payload` with `execution reverted`. Agentify says the cause is unknown and it cannot determine whether signing again, funding or a new purchase would help. `retryable` is false. | `not_paid`; no transaction or merchant hand-over. |
| Signature from a different wallet than the named payer | HTTP 409, `payment_not_verified`, facilitator code `invalid_exact_evm_payload_signature`. Agentify asks for a new signature. | `not_paid`; no transaction or merchant hand-over. |
| Payment naming another chain | HTTP 409, `payment_not_verified`. Agentify identifies the asset or chain mismatch before payment verification. | `not_paid`; no transaction or merchant hand-over. |

The empty wallet does not get a funding instruction: the facilitator's
`invalid_payload` does not establish insufficient funds. A generic contract
revert can have another cause, so attributing it to balance would be a guess.
An explicit insufficient-funds code already receives a funding instruction.
That branch is verified offline; the live facilitator does not return it in
this run.

Commit `dff70db3db7a7694483a3b648169547f6fc02369` makes the adapter read
facilitator refusal codes as whole codes. It reaches main through
[PR #201](https://github.com/nuanu-ai/agentify/pull/201), merged on
2026-10-26 at 14:03 UTC. `invalid_payload` is `unexplained`,
which preserves uncertainty. This behavior already exists in the deployed
runtime. The regression table now includes the exact code observed here.
The adapter and gateway suites pass 212 deterministic tests on Node 24.22.1.
A temporary mutation that classifies `invalid_payload` as `signature` is
applied and killed by that regression, then restored byte for byte; both
suites pass again. Payment logic, schemas and public fields are unchanged.

The temporary merchant and card are paused, the worker stops and its API key
is disabled. All six original catalogue entries remain. Raw responses, with
the bad signature redacted, and the check script remain in the private
`2026-10-27-eng05-lH1XBd` acceptance directory. The three attempts are unpaid.
Mainnet, other facilitator implementations and contract wallets are untested.

ENG05's reported wrong instruction is closed as not reproduced on the current
runtime. A reliably diagnosed empty-wallet funding action remains conditional
on what the payment service can establish; this check does not claim it.
