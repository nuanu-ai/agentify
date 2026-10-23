/**
 * How long a press of a Coinbase Wallet button waits for the wallet's window
 * to answer. The window can vanish without answering, as when a phone closes
 * its tab, and until the page stops waiting the wallet's session keys stay in
 * the page's storage. It is the longest a WebAuthn ceremony that verifies its
 * user is recommended to take, since approving in Coinbase's window is one,
 * and creating a wallet there takes a passkey too. It lives apart from the
 * requests, which bring the address code with them, so the settings page
 * fetches none of that before a press.
 */
export const WALLET_ANSWERS_WITHIN_MS = 10 * 60_000;
