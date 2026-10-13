/**
 * A state the page's own script brings about, drawn the way a browser draws
 * it: the page is rendered into a document, its requests are answered as the
 * scene says the site would answer them, the person's steps are taken once
 * the page shows what they act on, and the page is read once it shows the
 * state. It runs wherever a document is the global one: under the builder's
 * own document, and in a surface's check under its test document.
 */

import type { BrowserScene, GalleryState } from "./index.js";

/** The surface's React: its `act`, and the client renderer that draws into a document. */
export interface BrowserReact {
  readonly act: (work: () => Promise<void>) => PromiseLike<void>;
  readonly createRoot: (container: Element) => {
    render(drawn: ReturnType<GalleryState["draw"]>): void;
    unmount(): void;
  };
}

/** Long enough for a page's polls and lazy parts; a state that takes longer has stalled. */
const SETTLES_WITHIN_MS = 5_000;

/**
 * How long a page that shows the state must stay quiet, with no request of
 * its own unanswered, before it is read: what it asked for on the way may
 * still change what it shows.
 */
const QUIET_FOR_MS = 100;

const pathOf = (input: RequestInfo | URL): string =>
  new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    location.href,
  ).pathname;

const methodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

/**
 * The page's markup once it shows the state. A request the scene does not
 * answer fails the drawing rather than reach anywhere: a page that asked for
 * something unforeseen is not in the state the scene describes.
 */
export async function drawnInBrowser(
  state: GalleryState,
  scene: BrowserScene,
  react: BrowserReact,
): Promise<string> {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  history.replaceState(null, "", new URL(state.address, location.href).pathname);
  sessionStorage.clear();
  localStorage.clear();
  for (const [key, value] of Object.entries(scene.session ?? {}))
    sessionStorage.setItem(key, value);
  for (const [key, value] of Object.entries(scene.local ?? {})) localStorage.setItem(key, value);

  const unanswered: string[] = [];
  let lastAsked = Date.now();
  const fetched = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    lastAsked = Date.now();
    const asked = `${methodOf(input, init)} ${pathOf(input)}`;
    const answer = scene.answers?.[asked];
    if (answer === undefined) {
      unanswered.push(asked);
      throw new TypeError(`the gallery's scene does not answer ${asked}`);
    }
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  // A document with no layout has nothing to scroll, and a page that scrolls a
  // part into view shows nothing different for it in a still picture.
  const unscrollable = typeof Element.prototype.scrollIntoView !== "function";
  if (unscrollable) Element.prototype.scrollIntoView = () => {};
  const acting = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const wasActing = acting.IS_REACT_ACT_ENVIRONMENT;
  acting.IS_REACT_ACT_ENVIRONMENT = true;

  const root = react.createRoot(container);
  const shown = async (words: string): Promise<void> => {
    const by = Date.now() + SETTLES_WITHIN_MS;
    while (
      !(container.textContent ?? "").includes(words) ||
      Date.now() - lastAsked < QUIET_FOR_MS
    ) {
      if (unanswered.length > 0) {
        throw new Error(
          `The state ${state.id} asked for ${unanswered.join(", ")}, which its scene does not answer.`,
        );
      }
      if (Date.now() > by) {
        throw new Error(
          `The state ${state.id} never showed "${words}"; it showed: ${(container.textContent ?? "").slice(0, 300)}`,
        );
      }
      await react.act(() => new Promise((settle) => setTimeout(settle, 20)));
    }
  };
  try {
    await react.act(async () => root.render(state.draw()));
    for (const step of scene.steps ?? []) {
      await shown(step.shows);
      await react.act(async () => step.does(document));
    }
    await shown(scene.shows);
    // React moves a page's title into the document's head, where a server
    // that sends the whole page has it.
    const title = document.title;
    return title === "" || container.querySelector("title") !== null
      ? container.innerHTML
      : `<title>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</title>${container.innerHTML}`;
  } finally {
    await react.act(async () => root.unmount());
    globalThis.fetch = fetched;
    if (unscrollable) Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    acting.IS_REACT_ACT_ENVIRONMENT = wasActing;
    sessionStorage.clear();
    localStorage.clear();
    document.body.replaceChildren();
  }
}
