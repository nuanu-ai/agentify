import type { ReactNode } from "react";
import { isRouteErrorResponse, useLocation, useRouteError, useRouteLoaderData } from "react-router";
import { type Chrome, troubleIn } from "./answer.js";
import { GatePage } from "./components/gate-page.js";
import type { loader } from "./root.js";
import { NoSuchPage } from "./routes/no-such-page.js";

/**
 * The screen a press was made on, read off the address it posted to, which
 * is that screen's or one under it, and named as the sidebar names it; the
 * dashboard's start for anything else, which leads wherever the person
 * begins.
 */
const PRESSED_ON: Readonly<Record<string, readonly [string, string]>> = {
  products: ["/products", "Products"],
  orders: ["/orders", "Orders"],
  receipts: ["/receipts", "Receipts"],
  integrations: ["/integrations", "Integrations"],
  woocommerce: ["/woocommerce", "WooCommerce"],
  keys: ["/keys", "API keys"],
  settings: ["/settings", "Settings"],
  admin: ["/admin", "Admin"],
};

const screenOf = (path: string): readonly [string, string] =>
  PRESSED_ON[path.split(/[?#]/)[0]?.split("/")[1] ?? ""] ?? ["/", "the dashboard"];

/** One message panel: whether anything changed, why, and the one way on. */
function MessagePage({
  chrome,
  title,
  said,
  way,
}: Readonly<{ chrome: Chrome; title: string; said: ReactNode; way: readonly [string, string] }>) {
  return (
    <GatePage chrome={chrome} title={title}>
      <div className="message-panel">
        <h1>{title}</h1>
        <p>{said}</p>
        <a className="button button-primary" href={way[0]}>
          {way[1]}
        </a>
      </div>
    </GatePage>
  );
}

/**
 * The chrome comes with the trouble wherever the page's own loaders did not
 * run. The heading answers whether anything changed: a read changed nothing
 * and is offered again; a press refused changed nothing; a press that broke or
 * went unanswered may have been done, so the page sends the person to the
 * screen they pressed on to look before they press again, never to reload
 * an answer to a form, which would send the press a second time.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const root = useRouteLoaderData<typeof loader>("root");
  const { pathname } = useLocation();
  const trouble = troubleIn(error);
  const chrome = trouble?.chrome ?? root;
  if (chrome === undefined) {
    return <p>Something in the dashboard is broken.</p>;
  }
  if (trouble?.kind === "no-such-page") {
    return <NoSuchPage drawn={{ ...trouble.drawn, chrome }} />;
  }
  const [path, name] = screenOf(pathname);
  const open = [`${chrome.base}${path}`, `Open ${name}`] as const;
  if (trouble?.kind === "not-drawn-for-you") {
    // The gate's start is Products for somebody who sells, and the scanner's
    // latest report for somebody who does not, whom no screen here is for.
    const way =
      trouble.start === `${chrome.base}/products`
        ? open
        : ([trouble.start, "Open your latest report"] as const);
    return (
      <MessagePage
        chrome={chrome}
        title="Nothing was changed"
        said={
          <>
            You are signed in as <strong>{trouble.who}</strong>, and the page you pressed was not
            opened for this sign-in. Open it again to make the change.
          </>
        }
        way={way}
      />
    );
  }
  const again =
    trouble?.kind === "problem" || trouble?.kind === "unread" ? trouble.again : undefined;
  if (again !== undefined) {
    // A refusal is offered again only where it was a fault that may pass.
    const passing =
      trouble?.kind === "unread" || (isRouteErrorResponse(error) && error.status >= 500);
    return (
      <MessagePage
        chrome={chrome}
        title="This page could not be loaded"
        said={
          trouble?.kind === "problem"
            ? trouble.said
            : trouble?.kind === "unread" && trouble.answered === true
              ? "Your change was made, but the page could not be loaded after it."
              : "Loading it again changes nothing."
        }
        way={passing ? [again, "Try again"] : open}
      />
    );
  }
  // A press leads back to the page it was made on, its place in a list kept.
  const reopen =
    trouble?.kind === "problem" || trouble?.kind === "unanswered" || trouble?.kind === "broken"
      ? trouble.reopen
      : undefined;
  const back =
    reopen === undefined
      ? open
      : ([reopen, `Open ${screenOf(reopen.slice(chrome.base.length))[1]}`] as const);
  // A refused press did nothing where the server half says so, or where a
  // refusal came before any work; a fault nobody worded may have done it.
  if (
    trouble?.kind === "problem" &&
    (trouble.outcome === "refused" ||
      (trouble.outcome === undefined && isRouteErrorResponse(error) && error.status < 500))
  ) {
    return (
      <MessagePage chrome={chrome} title="Nothing was changed" said={trouble.said} way={back} />
    );
  }
  if (trouble?.kind === "broken") {
    return (
      <MessagePage
        chrome={chrome}
        title="Nothing was changed"
        said="Something broke on our side before anything was done. Try again in a moment."
        way={back}
      />
    );
  }
  if (trouble === undefined) {
    return (
      <MessagePage
        chrome={chrome}
        title="This page could not be shown"
        said={`Something broke on our side. If you pressed a button, check ${name} before you try again.`}
        way={open}
      />
    );
  }
  return (
    <MessagePage
      chrome={chrome}
      title="We don't know if this was done"
      said={`${trouble.kind === "problem" ? `${trouble.said} ` : ""}Something went wrong before we could confirm it. ${back[1]} to see where it stands; this sends nothing again.`}
      way={back}
    />
  );
}
