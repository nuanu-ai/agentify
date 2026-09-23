/**
 * The two screens a merchant keeps their keys on: the list, and the one page a
 * new key's secret is ever shown on.
 *
 * A key is what a merchant's own code opens the door with. ADR-0010 made each
 * one a row so that it can be revoked on its own — without touching any other
 * key, and without touching anybody's session in this cabinet — and ADR-0014 §5
 * brings that from a command somebody runs at a terminal to a screen.
 *
 * Three things about the list are decisions rather than layout. The revoked keys
 * are on it, because "which key did I turn off, and when" is a question
 * somebody has on exactly this screen and a list of only the working ones
 * answers it with silence. And every row on it is a key the merchant asked for:
 * the key this cabinet signs in with is of the other kind (ADR-0014 §5), the
 * gateway lists it nowhere and refuses to revoke it, so there is no row here
 * that could take a merchant's cabinet away from them. What the gateway does
 * say beside the list, as `this_call`, is the identifier of that key — for a
 * caller reaching the API with a key of the merchant's own, which is what needs
 * to know. This screen is not one of those and does not read it. The third is
 * the last call each key was seen on, which is the thing a merchant is here to
 * find out and the one place this screen can mislead them; `lastCall` below is
 * where an empty column is kept from turning into a claim about the key.
 *
 * An empty list follows from the same fact and is the ordinary state of a
 * merchant who has just registered: they have a cabinet because they signed
 * into one, and no keys because they have not put Agentify into any code of
 * their own yet. So it is the first thing most merchants see here, and it says
 * what it is rather than reporting an impossibility.
 *
 * Neither screen fetches anything or decides anything. Each is a function from
 * what the gateway answered to a page, which is what lets a test read the page
 * a merchant would be looking at.
 */

import type { MerchantKey, MerchantKeyList } from "@nuanu-ai/agentify-contracts";
import { escaped, page, type Row, table } from "./html.js";
import type { Viewer } from "./screens.js";
import { moment } from "./words.js";

const keyRow = (base: string, entry: MerchantKey): Row => {
  const revoked = entry.disabled_at !== null;
  return {
    ...(revoked ? { mark: "off" } : {}),
    cells: [
      {
        html: `<div class="title">${escaped(entry.label)}</div><div class="under mono">${escaped(entry.id)}</div>`,
      },
      { kind: "quiet", html: escaped(moment(entry.created_at)) },
      { kind: "quiet", html: escaped(lastCall(entry)) },
      {
        kind: "quiet",
        html: revoked ? escaped(`Revoked ${moment(entry.disabled_at ?? "")}`) : "Works",
      },
      { kind: "control", html: keyControl(base, entry) },
    ],
  };
};

/**
 * When something last called with this key, in the words a merchant reads.
 *
 * This is the column the screen is worth opening for — a merchant with three
 * keys is asking which of them is safe to turn off, and nothing else on the row
 * answers that. So it is also the column where being wrong costs the most, and
 * the whole of the danger is in the empty one.
 *
 * The gateway did not check whether anybody has called with a key; it wrote
 * down the calls it saw. Those are different claims, and a key made before it
 * started writing carries the same blank as a key nobody has ever used. So the
 * words here say what is true of both — there is no record — and stop. "Never
 * used" would be the confident version of a sentence nobody checked, on the
 * page where acting on it turns off a key that may be in the merchant's own
 * worker. Which of the two blanks a row is showing is not on the wire, and the
 * note under the table says so rather than the row pretending to know.
 *
 * The instant goes through `moment` like every other instant on these screens.
 * A second way of writing a time would put two formats on one page and a
 * merchant comparing them.
 */
const lastCall = (entry: MerchantKey): string =>
  entry.last_used_at === null ? NO_CALLS_RECORDED : moment(entry.last_used_at);

/**
 * The empty answer, named once because the note under the table quotes it.
 *
 * Written out in both places it would drift, and the drift is not cosmetic: the
 * note is the only thing that tells a merchant this blank covers two situations
 * and which one they are looking at cannot be known. A word in the table that
 * the explanation below no longer mentions is a word with nothing explaining
 * it.
 */
const NO_CALLS_RECORDED = "No calls recorded";

/**
 * What a merchant can do to one key from this list, which is sometimes nothing.
 *
 * A key that is already revoked shows nothing at all: there is no undo — a
 * revoked key never works again — and a control that looked like one would be a
 * promise the gateway does not make. Every other row gets the control, because
 * every other row is a working key the merchant issued and the gateway takes
 * this call for any of them.
 */
const keyControl = (base: string, entry: MerchantKey): string => {
  if (entry.disabled_at !== null) {
    return "";
  }
  // Named "Revoke" rather than "Disable", because it does not come back and the
  // word people already use for a credential that does not come back is this
  // one. The page says so in words above the table as well; a control with no
  // confirmation behind it should not be the only place that is said.
  return `<form class="inline" method="post" action="${escaped(base)}/keys/${encodeURIComponent(entry.id)}/disable">
<button class="button button-compact button-secondary" type="submit">Revoke</button></form>`;
};

/**
 * What this list is of, which is the sentence the empty one turns on.
 *
 * Said on the screen whether or not there is anything below it, because the
 * question a merchant has in front of no rows — "where is the key I am signed
 * in with, and should I be worried" — is answered by what the list is rather
 * than by what is missing from it. The answer to the second half of that
 * question is the link: the cabinet holds a key of its own, which is not on
 * this list and cannot be, and the portal's first step says so where somebody
 * setting up is reading anyway.
 */
const WHAT_A_KEY_IS =
  "A key is what your own code opens the door with, and this list is the keys you have asked for.";

const WHICH_KEY_THE_CABINET_USES =
  ' <a href="/docs/quickstart#_1-make-the-merchant-account-ready">Which key the cabinet itself' +
  " signs in with</a>.";

/**
 * What revoking does, beside the controls that do it rather than in the lede.
 *
 * It was four sentences at the top of the screen, read once by somebody who had
 * come to look at a list. What a merchant needs is the consequence at the
 * moment they are deciding which row to press, so it sits under the table the
 * Revoke buttons are in.
 */
const WHAT_REVOKING_DOES =
  "Revoking a key stops it from that moment and is not undone: your other keys go on working," +
  " nobody is signed out of this cabinet, and what replaces a revoked key is a new one.";

export const keysScreen = (viewer: Viewer, keys: MerchantKeyList, problem?: string): string => {
  const { base } = viewer;
  const working = keys.keys.filter((entry) => entry.disabled_at === null).length;
  const none = keys.keys.length === 0;

  const body = `
  <div class="lede">
    <div>
      <h1>API Keys</h1>
      <p>${escaped(
        none
          ? `You have issued no keys yet. ${WHAT_A_KEY_IS}` +
              " The first one you ask for below becomes the first row here."
          : `${working} of the ${keys.keys.length} ${keys.keys.length === 1 ? "key" : "keys"} below` +
              `${working === 1 ? " works" : " work"}. ${WHAT_A_KEY_IS}`,
      )}${WHICH_KEY_THE_CABINET_USES}</p>
    </div>
  </div>
${table(
  ["Name", "Made", "Last call", "State", ""],
  keys.keys.map((entry) => keyRow(base, entry)),
  "No keys yet.",
)}
${
  none
    ? ""
    : `  <p class="note">${escaped(WHAT_REVOKING_DOES)}</p>
  <p class="note">${escaped(
    "This is what the gateway answered with, and its answer does not say whether it is all of" +
      " them. Nothing pages this list yet and nothing here counts your keys for you — the number" +
      " above counts the rows below and nothing more.",
  )}</p>
  <p class="note">${escaped(
    "The last call is written down every few minutes rather than on every one, so a key" +
      ` something is using right now shows a time that far behind. "${NO_CALLS_RECORDED}" is` +
      ' what it says rather than "never used", and the difference matters for the keys you' +
      " have had the longest: we began recording this recently, so a key older than that shows" +
      " the same thing whether or not anything has been calling with it, and this page cannot" +
      " tell you which. Any key shows a time as soon as it is used again.",
  )}</p>`
}
  <div class="lede">
    <div>
      <h2>A new key</h2>
      <p>The name is how you tell keys apart here. The key itself is shown once, on the page that makes it.</p>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/keys">
    <div>
      <label for="label">What this key is for</label>
      <input id="label" name="label" type="text" autocomplete="off" required>
    </div>
    <button class="button button-compact button-primary" type="submit">Issue a key</button>
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  </form>
`;

  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "keys",
    title: "API Keys",
    body,
  });
};

/**
 * The one page a key's secret appears on, ever.
 *
 * It is answered straight from the post rather than after a redirect, which is
 * the one place in this cabinet that happens. A redirect cannot carry the
 * secret: putting it in the address would write it into the browser's history
 * and into every log between here and there, and keeping it anywhere to hand to
 * the next request would be storing the thing we have just promised not to
 * store. Once this page is drawn it replaces its history entry with a harmless
 * GET target, so a reload returns to the list rather than sending the form and
 * issuing another key.
 */
export const newKeyScreen = (viewer: Viewer, label: string, secret: string): string => {
  const { base } = viewer;
  const reloadTarget = JSON.stringify(`${base}/keys/new`).replaceAll("<", "\\u003c");
  const body = `
  <div class="lede">
    <div>
      <h1>Your new key</h1>
      <p>${escaped(`This is the key for "${label}". It is shown here and nowhere else, now and never again — nothing on our side keeps a readable copy of it, so a key you do not copy is a key you have to replace.`)}</p>
    </div>
  </div>
  <div class="scroller"><p class="secret" id="new-key-secret">${escaped(secret)}</p></div>
  <p><button class="button button-primary" id="copy-new-key" type="button">Copy key</button> <span id="copy-new-key-result" role="status"></span></p>
  <p class="note">${escaped(
    "Put it where your code reads its key from before you leave this page. If your browser ever" +
      " asks to resend the form, cancel: resending asks for another key.",
  )}</p>
  <p class="quiet"><a href="${escaped(base)}/keys">Back to your API keys</a></p>
  <script>
    history.replaceState(null, "", ${reloadTarget});
    document.getElementById("copy-new-key")?.addEventListener("click", async () => {
      const secret = document.getElementById("new-key-secret")?.textContent ?? "";
      const result = document.getElementById("copy-new-key-result");
      try {
        await navigator.clipboard.writeText(secret);
        if (result) result.textContent = "Copied.";
      } catch {
        if (result) result.textContent = "Could not copy. Select the key above.";
      }
    });
  </script>
`;

  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "keys",
    title: "Your new key",
    body,
  });
};
