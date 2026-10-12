/**
 * The key list and the one page a new key's secret is ever shown on. Each key
 * is a row revocable on its own, without touching any other key or any
 * dashboard session; the dashboard signs in by mailed link and calls the
 * gateway in-process, so no key is the dashboard's own way in and revoking one
 * cannot lock a merchant out. Revoked keys stay on the list, because "which key
 * did I turn off, and when" is asked on exactly this screen. An empty list is
 * the ordinary state of a merchant who has just registered.
 */

import type { MerchantKey } from "@nuanu-ai/agentify-contracts";
import { type Cell, escaped, momentCell, page, type Row, table, when } from "./html.js";
import type { Viewer } from "./screens.js";

const keyRow = (base: string, entry: MerchantKey): Row => {
  const revoked = entry.disabled_at !== null;
  return {
    ...(revoked ? { mark: "off" } : {}),
    cells: [
      {
        html: `<div class="title">${escaped(entry.label)}</div><div class="under mono">${escaped(entry.id)}</div>`,
      },
      momentCell(entry.created_at),
      lastCall(entry),
      {
        kind: "quiet",
        html: revoked ? `Revoked ${when(entry.disabled_at ?? "")}` : "Works",
      },
      { kind: "control", html: keyControl(base, entry) },
    ],
  };
};

/**
 * The column a merchant opens this screen for, deciding which key is safe to
 * turn off. The gateway records the calls it saw; a key made before it started
 * recording has the same blank as a key never used, and the wire does not say
 * which. So the words say there is no record, never "never used", and the note
 * under the table says the blank covers both.
 */
const lastCall = (entry: MerchantKey): Cell =>
  entry.last_used_at === null
    ? { kind: "quiet", html: escaped(NO_CALLS_RECORDED) }
    : momentCell(entry.last_used_at);

/**
 * Named once because the note under the table quotes it, and that note is the
 * only thing explaining what the blank covers.
 */
const NO_CALLS_RECORDED = "No calls recorded";

/**
 * A revoked key never works again, so it gets no control: anything there would
 * promise an undo the gateway does not make.
 */
const keyControl = (base: string, entry: MerchantKey): string => {
  if (entry.disabled_at !== null) {
    return "";
  }
  // "Revoke", not "Disable", because it does not come back. Two presses, the
  // first only opening the second: a details element does that without a
  // script, so a stray tap or a page whose script did not load cannot revoke
  // anything.
  return `<details class="confirm-revoke"><summary class="confirm-open button button-compact button-secondary">Revoke</summary>
<div class="confirm-pop"><p>This key will stop working for good.</p><form class="inline" method="post" action="${escaped(base)}/keys/${encodeURIComponent(entry.id)}/disable">
<button class="button button-compact button-primary" type="submit">Yes, revoke</button></form></div></details>`;
};

/**
 * Said whether or not there are rows, so an empty list is answered by what the
 * list is rather than by what is missing.
 */
const WHAT_A_KEY_IS = "Your code uses these keys to connect to Agentify.";

/** Under the table, beside the Revoke buttons, where the decision is made. */
const WHAT_REVOKING_DOES =
  "A revoked key stops working at once and for good. Your other keys keep working, and your" +
  " dashboard sign-in does not change. You can create a new key to replace it.";

export const keysScreen = (
  viewer: Viewer,
  keys: readonly MerchantKey[],
  problem?: string,
  // Autofocus scrolls to the form; a #fragment in the address would switch it
  // off.
  startNew = false,
): string => {
  const { base } = viewer;
  const working = keys.filter((entry) => entry.disabled_at === null).length;
  const none = keys.length === 0;

  const body = `
  <div class="lede">
    <div>
      <h1>API keys</h1>
      <p>${escaped(
        none
          ? `You haven't created any API keys yet. ${WHAT_A_KEY_IS}`
          : `${working} of the ${keys.length} ${keys.length === 1 ? "key" : "keys"} below` +
              `${working === 1 ? " works" : " work"}. ${WHAT_A_KEY_IS}`,
      )}</p>
    </div>
  </div>
${table(
  ["Name", "Created", "Last call", "State", ""],
  keys.map((entry) => keyRow(base, entry)),
  "No keys yet.",
)}
${
  none
    ? ""
    : `  <p class="note">${escaped(WHAT_REVOKING_DOES)}</p>
  <p class="note">${escaped(
    "This list is what the gateway returned, and it does not say whether that is every key." +
      " The number above counts the rows below, nothing more.",
  )}</p>
  <p class="note">${escaped(
    "The last call time updates every few minutes, so it can lag a little behind." +
      ` "${NO_CALLS_RECORDED}" does not mean the key was never used: we started recording calls` +
      " recently, so for an older key this page cannot tell which it is until the key is used again.",
  )}</p>`
}
  <div class="lede">
    <div>
      <h2>A new key</h2>
      <p>The name helps you tell keys apart. The key itself is shown only once, right after you create it.</p>
    </div>
  </div>
  <form class="issue key-name" method="post" action="${escaped(base)}/keys">
    <div>
      <label for="label">What this key is for</label>
      <input id="label" name="label" type="text" autocomplete="off"${startNew ? " autofocus" : ""} required>
    </div>
    <button class="button button-primary" type="submit">Issue a key</button>
    ${problem === undefined ? "" : `<p class="problem">${escaped(problem)}</p>`}
  </form>
`;

  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "keys",
    title: "API keys",
    body,
  });
};

/**
 * Answered straight from the POST rather than after a redirect, the one place
 * in the dashboard that does: a redirect cannot carry the secret without
 * writing it into history and logs, or storing it for the next request. Once
 * drawn, the page replaces its history entry with a harmless GET target, so a
 * reload returns to the list instead of issuing another key.
 */
export const newKeyScreen = (viewer: Viewer, label: string, secret: string): string => {
  const { base } = viewer;
  const reloadTarget = JSON.stringify(`${base}/keys/new`).replaceAll("<", "\\u003c");
  const body = `
  <div class="lede">
    <div>
      <h1>Your new key</h1>
      <p>${escaped(`This is the key for "${label}". It is shown only here and only once: we do not keep a readable copy. If you do not copy it now, you will have to create a new one.`)}</p>
    </div>
  </div>
  <div class="scroller"><p class="secret" id="new-key-secret">${escaped(secret)}</p></div>
  <p><button class="button button-primary" id="copy-new-key" type="button">Copy key</button> <span id="copy-new-key-result" role="status"></span></p>
  <p class="note">${escaped(
    "Save the key where your code reads it from before you leave this page. If your browser asks" +
      " to resend the form, cancel: resending creates another key.",
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
