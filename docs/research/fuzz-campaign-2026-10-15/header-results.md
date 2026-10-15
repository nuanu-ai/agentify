# Accepted-card discovery header compatibility

The registered header-width experiment confirms one compatibility defect,
suggested priority P2. A card with 256 declared scalar parameters is accepted
from a 7,867-byte publication document, but its 18,896-byte `PAYMENT-REQUIRED`
header cannot be read by ordinary Node HTTP or native `fetch` clients in the
measured runtime. The merchant SDK reports successful publication while the
buyer's client cannot receive the payment challenge needed to buy that card.

The subject is product commit
`e11fef741e875ef6f9c42465a6b27577dd2921a1`. Root executes the eight widths
registered in [the plan](plan.md), using the existing access-card documentation
fixture with parameter declarations added. Every publication stays below the
262,144-byte input cap. The response is read once with a one-megabyte header
allowance to measure what the gateway sends, and once with the HTTP client's
unchanged default. [The primary ledger](header-evidence.json) records all rows.

| Declared parameters | Publication bytes | Payment header bytes | Default Node HTTP |
| ---: | ---: | ---: | --- |
| 1 | 323 | 1,844 | 402 challenge received |
| 32 | 1,214 | 3,848 | 402 challenge received |
| 64 | 2,142 | 5,936 | 402 challenge received |
| 128 | 4,027 | 10,192 | 402 challenge received |
| 256 | 7,867 | 18,896 | `HPE_HEADER_OVERFLOW` |
| 512 | 15,547 | 36,304 | `HPE_HEADER_OVERFLOW` |
| 1,024 | 30,932 | 71,184 | `HPE_HEADER_OVERFLOW` |
| 2,048 | 62,676 | 143,548 | `HPE_HEADER_OVERFLOW` |

The measured runtime is Node `v26.7.0`; `node:http.maxHeaderSize` reports
16,384 bytes. The enlarged reader receives a 402 challenge at every width.
The first failing sampled width is 256, while 128 succeeds. The experiment
does not establish the exact smallest failing width, nor does it measure the
limits of other Node versions, browsers, proxies or HTTP libraries.

An independent replay publishes the 256- and 512-parameter cards through the
actual merchant SDK rather than calling the publication route directly. Both
return `{ ok: true }`. With an enlarged header allowance, both responses are
valid 402 challenges whose decoded declarations contain all 256 or 512 fields
and the expected atomic price of 5,000,000. Default Node HTTP fails with
`HPE_HEADER_OVERFLOW`; unmodified native `fetch` fails with
`UND_ERR_HEADERS_OVERFLOW` at both widths. [The independent ledger](header-independent-evidence.json)
contains those observations without merchant keys, signatures or raw payment
headers. No authorization is created and no payment executes.

The owning path is admission through to discovery serialization:

* `packages/contracts/src/param-spec.ts:25` bounds parameter-name format but
  leaves its length open; `:58` defines the declaration record without a
  field-count limit.
* `apps/gateway/src/http/server.ts:69` limits the request body to 256 KiB.
  `apps/gateway/src/app/gateway.ts:454` parses the card, and `:496` stores an
  admitted card without checking its encoded challenge size.
* `packages/contracts/src/card.ts:858` creates one example value per declared
  field; `:866` renders the purchase JSON Schema; `:913` places both in the
  discovery declaration.
* `apps/gateway/src/http/x402.ts:158` carries that declaration into the payment
  challenge, and `:189` encodes the complete challenge as a header value.
  `apps/gateway/src/http/routes.ts:412` sends it on the unpaid purchase probe.

No declared public parameter-count, parameter-name-length or encoded-header
admission bound tells the integrator that this accepted card is unusable by
these clients. This is therefore a product compatibility defect under the
promise that accepted cards remain usable. It is not a claim that the gateway
returns malformed JSON: the enlarged-reader control decodes the response
successfully, and the ordinary client rejects its header size before the
application can read the challenge.

The primary experiment initially asks the wrong URL without `/purchase` and
receives 404; that is a corrected harness error, excluded from the measured
rows. The independent replay initially uses a direct `tsx` runner that cannot
import the gateway's Vitest-dependent testing harness; it then runs successfully
inside one temporary Vitest test. Those runner errors provide no product evidence.
Product code remains unchanged, and no deployed service is contacted.
