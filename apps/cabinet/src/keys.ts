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
import { escaped, page } from "./html.js";
import type { Viewer } from "./screens.js";
import { moment } from "./words.js";

const keyRow = (base: string, entry: MerchantKey): string => {
  const revoked = entry.disabled_at !== null;
  return `<tr class="${revoked ? "off" : ""}">
<td><div class="title">${escaped(entry.label)}</div><div class="under mono">${escaped(entry.id)}</div></td>
<td class="quiet">${escaped(moment(entry.created_at))}</td>
<td class="quiet">${escaped(lastCall(entry))}</td>
<td class="quiet">${revoked ? escaped(`Revoked ${moment(entry.disabled_at ?? "")}`) : "Works"}</td>
<td class="control">${keyControl(base, entry)}</td>
</tr>`;
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
 * Where the answer to "which key am I signed in with" is written.
 *
 * The cabinet holds a key of its own, which is not on this list and cannot be.
 * That used to be a sentence on the screen; it is a question somebody asks
 * once, so it is the link at the end of the counts line and the portal's first
 * step answers it where somebody setting up is reading anyway.
 */
const WHICH_KEY_THE_CABINET_USES =
  ' <a href="/docs/quickstart#_1-make-the-merchant-account-ready">Which key the cabinet uses</a>.';

/**
 * What revoking does, in the line over the table the Revoke buttons are in.
 *
 * It was four sentences at the top of the screen, then a paragraph under the
 * table. There is no confirmation behind that button, so the fact that it does
 * not come back has to be on the screen; what a merchant also wants to know at
 * that moment is whether pressing it breaks anything else of theirs.
 */
const REVOKING_IS_PERMANENT = "Revoking one is permanent; your other keys keep working.";

export const keysScreen = (viewer: Viewer, keys: MerchantKeyList, problem?: string): string => {
  const { base } = viewer;
  const working = keys.keys.filter((entry) => entry.disabled_at === null).length;
  const none = keys.keys.length === 0;

  const body = `
  <div class="lede">
    <div>
      <h1>API Keys</h1>
      ${
        // No counts line over an empty list. "0 of the 0 keys below work" is
        // arithmetic about nothing, and the empty state below already says
        // what a merchant with no keys is looking at.
        none
          ? ""
          : `<p>${escaped(
              `${working} of ${keys.keys.length} ${keys.keys.length === 1 ? "key" : "keys"} ${working === 1 ? "works" : "work"}. ${REVOKING_IS_PERMANENT}`,
            )}${WHICH_KEY_THE_CABINET_USES}</p>`
      }
    </div>
  </div>
${
  none
    ? '<div class="scroller"><p class="empty">No keys yet.</p></div>'
    : `<div class="scroller"><table>
<thead><tr><th>Name</th><th>Made</th><th>Last call</th><th>State</th><th></th></tr></thead>
<tbody>${keys.keys.map((entry) => keyRow(base, entry)).join("")}</tbody>
</table></div>
  <p class="note">${escaped(
    // Three truncations in one footnote, because all three are about trusting
    // this table before pressing Revoke. A blank cell is not a claim that
    // nothing called; a time on it is not the last call but the last one
    // written down; and the list is not a claim that these are all the keys.
    `"${NO_CALLS_RECORDED}" means never used or older than our record; times lag a few minutes.` +
      " The list may not be complete.",
  )} <a href="/docs/quickstart#_1-make-the-merchant-account-ready">Keys and the first call</a>.</p>`
}
  <div class="lede">
    <div>
      <h2>A new key</h2>
    </div>
  </div>
  <form class="issue" method="post" action="${escaped(base)}/keys">
    <div>
      <label for="label">What this key is for</label>
      <input id="label" name="label" type="text" autocomplete="off" required>
      <p class="quiet">The key itself is shown once, when it is made.</p>
      ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
    </div>
    <button class="button button-compact button-primary" type="submit">Issue a key</button>
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
      <p>${escaped(`The key for "${label}". Copy it now: this is the only time it is shown.`)}</p>
    </div>
  </div>
  <div class="scroller"><p class="secret" id="new-key-secret">${escaped(secret)}</p></div>
  <p><button class="button button-primary" id="copy-new-key" type="button">Copy key</button> <span id="copy-new-key-result" role="status"></span></p>
  <p class="note">${escaped(
    "If your browser asks to resend the form, cancel — resending issues another key.",
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
