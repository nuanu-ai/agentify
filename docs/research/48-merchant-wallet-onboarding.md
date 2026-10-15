# A merchant without a crypto wallet: three ways to one they can be paid in and spend from

Date: 2026-10-15. A research note for the product owner, which may be
rewritten. It compares ways a merchant who has never held cryptocurrency gets
from the dashboard's settings to money they can use, and ends with the
questions only the product owner can answer. It chooses nothing, and nothing
is built from it until the product owner has chosen.

## The question

The last step before a merchant publishes goods is the payout wallet: the
dashboard asks for an address on Base, the network buyers pay in, and refuses
to publish without one. A merchant who has never held cryptocurrency stops
there, because to answer they must leave the dashboard, choose a wallet, learn
what Base and USDC are and come back with an address. The product owner's
working hypothesis is that a merchant who can get a wallet without leaving the
dashboard will finish.

Getting a wallet is the first of three places such a merchant stops, and a
way through the first alone moves the stop to the place where money has
already arrived and cannot be used. The second place is receiving: a buyer
pays the merchant's split, a contract nobody owns that keeps the money until
some transaction pays the merchant's share out to their wallet
(`docs/decisions/0037-every-payment-goes-to-the-merchants-split.md`). The
third is turning USDC, a dollar token on the chain, into dollars in a bank.
Each way below is followed through all three.

## The weight measurement, registered before it ran

The dashboard holds every page to 100 KB of script, compressed with brotli as
it is sent, on the page's first visit (`apps/dashboard/src/budget.ts`). On
this branch, built on 2026-10-15, the settings page, where the payout wallet
is set, loads 93.9 KB, and the heaviest page 95.1 KB. A wallet provider's
browser code can therefore only arrive after a click, through an `import()`,
which the budget check prints beside the page without counting it. This
section fixes, before anything is installed, what is measured, what is
expected and how the numbers are reported. Nothing in it changes after the
commit that adds it; the results are appended under their own heading.

The measurement lives on the branch `spike/wallet-weight`, which is deleted
once this note reaches `main`. For each provider in turn it adds the
provider's packages to the dashboard at an exact version and, on the settings
page, a button whose click handler loads by `import()` a module doing the
smallest thing the provider needs to hand back an address:

- B, the Base Account SDK, `@base-org/account@2.5.13`:
  `createBaseAccountSDK({ appName, appChainIds: [84532] }).getProvider()` and
  one `eth_requestAccounts` request.
- C, Coinbase Developer Platform's embedded wallet without its interface,
  `@coinbase/cdp-core@0.0.127`: initialisation with a project identifier,
  sign-in by email with its one-time code, and reading the wallet's EVM
  address, under the names its type declarations give.
- R, the same wallet with Coinbase's ready-made interface,
  `@coinbase/cdp-react@0.0.127` with `@coinbase/cdp-hooks@0.0.127`: its
  provider component and its sign-in button rendered where the button was.

The exchange's deposit address needs no browser code, so it is not measured.

What is measured, each time on a production build of the dashboard:

- M1. The brotli-compressed bytes of every script the click loads that the
  settings page has not already loaded, read from Vite's manifest the way the
  budget check reads it.
- M2. The first-visit script of every page, as the budget check prints it,
  against the figures above.
- M3. Whether `pnpm --filter @agentify/dashboard build` succeeds with the
  dashboard's Vite configuration unchanged. Where it does not, the error, and
  the smallest change to the configuration that makes it build, which is then
  the build measured.

What is expected:

- P1. M1 for B lies between 120 KB and 300 KB.
- P2. M1 for C is above 100 KB.
- P3. M1 for R is above M1 for C.
- P4. With each provider, no page's first visit grows by more than 0.5 KB.
- P5. B builds with the configuration unchanged; C and R do not, for want of
  a browser stand-in for a Node built-in such as `Buffer`.

How the numbers are read: the measurement chooses no provider. Its figures
enter the comparison below as they are. A provider for which P4 fails carries
into the comparison, as a cost of building it, the work of keeping its code
out of the first visit; a provider that needs a change to the build carries
that change. A prediction that fails is reported as failed, with the number
that failed it.

### Results

The measurement ran on 2026-10-15 at commit `14edad7` of `spike/wallet-weight`,
with Node 24.22.0, pnpm 11.12.0 and the dashboard's own Vite 7.3.6 and React
Router 8.4.0; `spike/measure.sh` there prints everything below, and
`spike/measured-2026-10-15.txt` is its output. One build was added that the
registration did not name: a control, the same button importing a module with
no provider in it, so that the button's own weight can be told apart from the
provider's.

| Build | M1: what the click loads, brotli | the same, uncompressed | M2: settings pages | M2: every other page | M3 |
| --- | --- | --- | --- | --- | --- |
| Control, no provider | 0.1 KB | 0.0 KB | 94.4–94.5 KB, +0.5–0.6 | +0.0 | builds |
| B, Base Account SDK | 160.8 KB | 550.3 KB | 94.5–94.6 KB, +0.6–0.7 | +0.0–0.1 | builds |
| C, CDP embedded wallet, no interface | 86.4 KB | 350.8 KB | 94.6–94.7 KB, +0.7–0.8 | +0.1–0.2 | builds |
| R, CDP embedded wallet with Coinbase's sign-in | 417.3 KB and a 5.1 KB stylesheet | 1880.8 KB | 94.8–94.9 KB, +0.9–1.0 | +0.3–0.4 | builds |

The changes in M2 are against the figures measured before the spike, 93.9 KB
on the settings pages and 91.5–95.1 KB elsewhere; the budget check prints one
decimal, so a change of 0.1 KB is within its rounding.

P1 held: B's click loads 160.8 KB, inside the predicted 120–300 KB. P2 failed:
C's click loads 86.4 KB, not more than 100 KB. P3 held, and for a reason the
prediction did not foresee: `@coinbase/cdp-react@0.0.127` depends on
`@base-org/account@2.5.13`, so R carries the Base Account SDK as well as its own
interface. P4 failed as it was written: the settings pages grew by 0.6–1.0 KB
with every provider. The control shows where that came from: the button and
its `import()` alone add 0.5–0.6 KB to the settings pages and nothing
elsewhere, and what each provider adds to any page's first visit on top of the
control is at most 0.1 KB for B, 0.2 KB for C and 0.4 KB for R, which is code
the provider shares with the dashboard being moved by the bundler into chunks
the first visit already loads. P5 failed for C and R: all three built with the
Vite configuration unchanged. Installing C and R did need a decision of
another kind: pnpm 11 refuses to install until `bufferutil` and
`utf-8-validate`, native modules of the WebSocket library `ws` reached through
Solana's client inside `@coinbase/cdp-core`, are allowed or declined a build
script, and the spike declined both. Whether C and R then run in a browser
without a stand-in for Node's `Buffer` was not tested: the measurement built
the code and did not run it.

Three things were read in the built code and the packages' sources while
measuring, outside the registration. B, unless told `telemetry: false`, inserts
an inline script into the page's head that starts Coinbase's analytics client
and sends events to `cca-lite.coinbase.com`
(`dist/core/telemetry/initCCA.js`; the option defaults to `true` in
`dist/core/provider/interface.d.ts`). C's code names the same host and its
configuration has a `disableAnalytics` switch. And B depends at run time on
`@coinbase/cdp-sdk@1.58.0`, Coinbase's server SDK, while the gateway uses
1.55.0, so the lockfile would carry two copies of it.
