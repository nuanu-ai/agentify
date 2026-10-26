/**
 * How long the dashboard waits for the gateway, which a page in the browser
 * waits out too before it says an answer could not be confirmed. A module of
 * its own with nothing imported, because the React pages read it in the
 * browser.
 */

/**
 * The default deadline for one call: a guard on a page, shorter than a
 * person's patience. The work behind a call that runs out is not cancelled (a
 * late database still writes), so the page says it may have been done. A
 * caller may pass its own: a payout wallet change passes a longer one
 * (`WALLET_CHANGE_MS`), because on live the gateway answers only after every
 * announcement is handed to the mail provider, and tests pass a shorter one so
 * as not to wait ten seconds.
 */
export const ANSWER_WITHIN_MS = 10_000;

/**
 * How long a change of the payout wallet is waited for: longer than a screen's
 * ten seconds, because on live the gateway answers only after every message
 * about it is handed to the mail provider, which may take twenty seconds
 * (`ANNOUNCEMENT_ANSWER_MS` in the gateway). Stopping sooner would tell a
 * person the gateway did not answer while their change was being recorded.
 */
export const WALLET_CHANGE_MS = 30_000;

/**
 * How long a press on a payout wallet form may take in all: the gateway's read
 * of the wallet and then its change, each allowed `WALLET_CHANGE_MS`, and the
 * Settings page drawn again after them. A page waits this out before it says
 * the change could not be confirmed, so that it never says so while the
 * gateway is still recording it.
 */
export const WALLET_PRESS_MS = 2 * WALLET_CHANGE_MS + ANSWER_WITHIN_MS;
