/**
 * The key an account's cabinet calls the gateway with, and when it is renewed.
 *
 * ADR-0014 §2: the key is made afresh at every sign-in and at the first request
 * of each day on a live session, and the one it replaces is forgotten, so the
 * keys in a copy of this database taken today stop working at their people's
 * next visits. The first request of a day is the one whose reading of the
 * session moved the session's end, which the component does at most once a
 * day per session (`identity.ts`); a reading that moved it is what every door
 * that reads a session hands to `sessionReader`, so the cabinet's own pages and
 * the scanner's question about a cookie renew the key alike.
 */

import type { CabinetIdentity, LiveSession, Person } from "./cabinet-entry.js";
import type { GatewayClient } from "./gateway.js";

/**
 * How long the cabinet waits on the gateway for its own key, per call.
 *
 * Shorter than the deadline every screen gets, and that is the whole reason
 * there are two numbers. A screen is worth ten seconds because somebody is
 * looking at it and would rather wait than start again. The two calls that
 * replace this cabinet's key are not a screen: nobody asked for them, nothing
 * on the page depends on them, and a sign-in held open for as long as a
 * catalogue is the same locked door as a gateway that is down, only slower and
 * less honest about it. Two seconds a call, so the worst a silent gateway can
 * add to somebody's sign-in is four — and what it costs is that the key is not
 * replaced this time, which is a thing that can wait until the next sign-in.
 */
export const KEY_AT_SIGN_IN_MS = 2_000;

/**
 * Replaces the key on somebody's row with a fresh one.
 *
 * ADR-0014 §2 asks for it: the key is stored as the gateway issued it, so a
 * copy of this cabinet's database is a set of working keys, and what decides
 * how long they are worth stealing is this. After it, the key that copy holds
 * is one the gateway has forgotten.
 *
 * Three steps, and the order is the substance. Ask for a key with the one
 * already on the row; move the row from that key to the fresh one; then put
 * the key that is now out of use beyond use. Cut the power at any point and a
 * working key is on the row: after the first step the old one, still live;
 * after the second the fresh one, with the old one alive beside it; after the
 * third the fresh one alone. Forgetting before the write is the one
 * arrangement that cannot be interrupted safely, because the row would be
 * left naming a key that no longer exists, and its owner would be locked out
 * of their own cabinet by the act of signing into it.
 *
 * The write is conditional on the row still holding what this sign-in read
 * off it, which is what decides which key this sign-in has finished with.
 * Win, and the row has moved off the old key: no later write can put it back,
 * because every sign-in still expecting it will now lose the same way, so the
 * old key is this one's to forget. Lose, and the row never held the fresh key
 * and never will — nothing but this sign-in could have written it, and this
 * sign-in has lost — so the fresh key is the one to forget. Either way what
 * goes is a key proved to be neither current nor able to become current, and
 * the call that removes it is made with it. Interleave as many sign-ins as
 * you like: no call can reach a key another sign-in wrote after it was sent,
 * because reaching a key means holding it, so the row always names a key that
 * works. If the database answer is lost, neither conclusion is safe: the
 * row may hold either key, so both remain live and the next sign-in retries.
 *
 * What that gives up is the sweeping. Nobody clears anybody else's leavings
 * any more, so a sign-in interrupted between the write and the forgetting
 * leaves one key alive that nothing will ever come back for. That is a row
 * per interrupted sign-in and it is the right trade: the alternative is a
 * call able to take away a key somebody is holding. Clearing them by age, if
 * it is ever worth doing, is counted from this side — the cabinet is the
 * party that knows every key still on a row — and it is not built.
 *
 * None of it may stand between a person and their cabinet. A gateway that is
 * down, one that refuses, one that answers something the contract does not
 * recognise — each costs a line in the log and nothing more, and they are
 * signed in on a key that works. The last of those three arrives as a throw
 * rather than as an answer, which is why the whole of this is caught: the
 * client holds what comes back to the contract's schema, and a document it
 * refuses must not become a person who cannot sign in. Nothing about signing
 * in belongs to the gateway anyway — the proof, the session and the row are
 * this cabinet's own.
 *
 * It runs before the cookies are handed over rather than after the answer,
 * and that is not tidiness. The key is read off the row on every request, so
 * a first request racing an unfinished replacement could read the old key and
 * be refused with it. What is left is a narrower window: a request already in
 * flight from another device, which read the row before the write, is made
 * with the key this sign-in is about to forget and is refused. It is
 * milliseconds wide, it costs a page reload, and the only way to buy it off
 * would be to leave the old key alive for a while — which is the thing this
 * exists to stop.
 */
export const keyRenewal =
  (
    identity: Pick<CabinetIdentity, "replaceMerchantKey">,
    clientFor: (key: string, answerWithinMs?: number) => GatewayClient,
  ) =>
  async (person: Person): Promise<void> => {
    const holding = person.merchant?.key;
    if (holding === undefined) {
      return;
    }

    /** Puts one key beyond use, with itself, and never fails a sign-in. */
    const forget = async (key: string, which: string): Promise<void> => {
      const gone = await clientFor(key, KEY_AT_SIGN_IN_MS).forgetCabinetKey();
      if (!gone.ok) {
        console.error(`[cabinet] a person signed in and ${which} is still working: ${gone.why}`);
      }
    };

    try {
      const made = await clientFor(holding, KEY_AT_SIGN_IN_MS).issueCabinetKey();
      if (!made.ok) {
        console.error(
          "[cabinet] a person is signed in on the key their account already held:" +
            ` no fresh one was made — ${made.why}`,
        );
        return;
      }

      // Conditional on the row still holding what was read off it, which is
      // what makes the write and the choice of which key to forget one act
      // rather than two moments with a gap between them.
      const replaced = await identity.replaceMerchantKey(person.id, holding, made.document);
      if (replaced === "replaced") {
        // The row has moved off the key this sign-in arrived with, and no later
        // write can put it back. It is this sign-in's to forget, and this is
        // the only party holding it.
        await forget(holding, "the key it replaced");
        return;
      }

      if (replaced === "unknown") {
        // The write may have committed before its answer was lost. Revoking
        // either key could therefore revoke the one now on the row.
        console.error(
          "[cabinet] the database could not establish whether the account key was replaced;" +
            " neither key was revoked",
        );
        return;
      }

      // Somebody else moved the row first. The fresh key was never on it and
      // never will be — only this sign-in could have written it, and it has
      // lost — so this is what this sign-in has to clear up, and the key on the
      // row is left alone because it belongs to whoever won.
      console.error(
        "[cabinet] a person is signed in on the key their account holds:" +
          " a fresh one was made and the row had already moved on from what this sign-in read",
      );
      await forget(made.document, "the key it made and did not use");
    } catch {
      // Which step it was is in the exception and not worth unpacking into
      // three sentences: whichever it was, the row names a key the gateway
      // takes, because the only write here is conditional on the row and the
      // only key ever removed is one this sign-in had finished with.
      console.error(
        "[cabinet] a person is signed in and the key on their account was not replaced",
      );
    }
  };

/**
 * Reads a request's session, and renews the key when the reading was the first
 * of the session's day.
 *
 * The person is read again after a renewal, because the key the first reading
 * carried may be the one the renewal has just forgotten, and a handler that
 * called the gateway with it would be refused. The renewed cookie lines of the
 * first reading are the ones the browser needs, so they are the ones kept.
 */
export const sessionReader =
  (identity: Pick<CabinetIdentity, "whoIs">, renewKey: (person: Person) => Promise<void>) =>
  async (cookieHeader: string | undefined): Promise<LiveSession | null> => {
    const session = await identity.whoIs(cookieHeader);
    if (session === null || session.setCookies.length === 0 || session.person.merchant === null) {
      return session;
    }
    await renewKey(session.person);
    const renewed = await identity.whoIs(cookieHeader);
    return renewed === null ? null : { person: renewed.person, setCookies: session.setCookies };
  };
