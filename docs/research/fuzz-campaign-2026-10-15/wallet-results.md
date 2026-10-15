# Wallet response correctness campaign

This extension is registered before its tests execute. Its subject is product
commit `e11fef741e875ef6f9c42465a6b27577dd2921a1`. The scope is the real
`sendPayout` request function and `CoinbasePayout` React component, with a local
EIP-1193 provider boundary. No wallet SDK, chain, transaction signer or deployed
environment is contacted. Product code remains unchanged.

Twenty logical cases cover ten response cells through both the request function
and the component. The cells are account rejection (4001), submission rejection
(4001), provider submission failure (-32603), lost session (4100), four resolved
malformed answers (`null`, absent, empty object, numeric `id`), an acknowledged
pending batch and a submitted batch acknowledgment. The component is rendered
in jsdom and its button is pressed; the actual request implementation handles
the provider's answer. Only construction of the external provider is replaced.

Rejection, provider failure and an unreadable answer must retain their distinct
outcomes. A malformed answer supplies no evidence that a payout was sent. A
valid batch acknowledgment may produce the application's existing `sent`
outcome: its contract explicitly means wallet acceptance, with network
inclusion still unconfirmed (`app/wallet/requests.ts:117`). The component must
retain that qualification. The two valid cases therefore test the same allowed
claim despite different provider-side submission states.

The independent protocol reference is
[EIP-5792](https://eips.ethereum.org/EIPS/eip-5792#wallet_sendcalls): its
`wallet_sendCalls` response carries a batch identifier, while a separate status
method distinguishes pending from confirmed execution. The experiment does not
assume that a batch identifier is a transaction receipt. It makes no assertion
about later execution on a real chain.

The source currently returns `sent` after any resolved `wallet_sendCalls`
answer, without inspecting the answer (`app/wallet/requests.ts:135`). Whether
the four malformed responses consequently produce an unsupported success claim
is a preregistered hypothesis. Confirmed reproductions remain executable as
expected failures so the normal test command stays usable. Runtime or fixture
errors are reported separately.

All 20 registered cases execute. Twelve consumer promises hold and eight
reproductions demonstrate one defect. The runner reports 20 passing tests
because the eight reproductions use `it.fails`; this is not a claim that all
20 consumer promises hold. [The sanitized ledger](wallet-evidence.json) records
actual outcomes and distinguishes those counts explicitly.

| Response group | Cases | Consumer result |
| --- | ---: | --- |
| Account or payout rejection | 4 | Cancellation remains distinct from failure and uncertainty |
| Provider failure | 2 | The provider's reason reaches the caller and the component |
| Lost session | 2 | The component states that the submission outcome is unknown |
| Malformed resolved acknowledgment | 8 | Defect reproduced through both surfaces for all four response shapes |
| Valid pending or submitted acknowledgment | 4 | The component uses its existing wallet-acceptance message, qualified by later network execution |

The confirmed defect is a success claim without a readable batch
acknowledgment, suggested priority P2. `sendPayout` ignores the value returned
by `wallet_sendCalls` and returns `{ kind: "sent" }` for `null`, `undefined`,
`{}` and `{ id: 7 }`. `CoinbasePayout` then selects its sent message at
`app/wallet/buttons.tsx:193`. A merchant can consequently be told that a payout
was sent when the provider's response proves no such submission. This is one
defect with eight reproductions, rather than eight separate findings. No test
establishes that the installed Coinbase service returns these malformed values;
the confirmed behavior is how Agentify handles them at its provider boundary.

A minimal request reproduction supplies a provider that answers
`eth_requestAccounts` with the existing EIP-55 example address, accepts the
chain switch with `null`, and resolves `wallet_sendCalls` with `null`.
`sendPayout` reports `sent`. The same provider, constructed at the external
provider boundary, makes the real component select its sent status after a
button press. Removing the expected-failure annotations in an isolated copy
and replaying the two null-response cases produces two ordinary assertion
failures, with 18 unrelated cases deselected. The observed outcomes are recorded
before either assertion, so a fixture exception cannot stand in for this result.

The two valid acknowledgments deliberately carry no receipt or confirmation.
The pending/submitted labels are fixture context, not observed chain facts.
The application contract already defines `sent` as wallet acceptance; its
current message directs the merchant to the payout contract's page for later
network execution. No finding is raised solely because the valid acknowledgment
arrives while execution can still be pending.

The command is:

```sh
AGENTIFY_WALLET_CAMPAIGN_EVIDENCE=/tmp/agentify-wallet-evidence.json \
pnpm exec vitest run --project unit \
  apps/dashboard/app/wallet/wallet-response-campaign.test.tsx \
  --maxWorkers=1 --reporter=json --outputFile=/tmp/agentify-wallet-vitest.json
```

Dashboard typechecking and Biome pass. An unmodified isolated copy completes
the same 20 tests. Changing the copied rejection code from 4001 to 4002 is a
mutation killed by four cancellation cases across the request and component.
An initial isolated-control attempt collects no tests because jsdom resolves a
`/var` scratch root differently from its `/private/var` path; resolving the root
to its real path corrects that harness failure. Product source is not mutated.
This campaign does not cover a connected wallet, provider window, transaction
signing, deployed browser, actual submission or on-chain confirmation.
