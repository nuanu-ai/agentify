import { Button } from "@agentify/ui";
import { lazy, Suspense, useContext } from "react";
import type { ShopJobView } from "../../src/shop-job-view.js";
import type { ConnectionView, ImportHeld, WooShopView } from "../../src/woo-views.js";
import { Moment } from "../components/moment.js";
import { Word } from "../components/word.js";

const RatePanel = lazy(() =>
  import("./woo-rate.js").then(({ RatePanel }) => ({ default: RatePanel })),
);

const OnboardingAccount = lazy(() =>
  import("./onboarding-account.js").then(({ OnboardingAccount }) => ({
    default: OnboardingAccount,
  })),
);

import { ProductsShop, ShopAccount, ShopForm } from "./shop-context.js";
import styles from "./woocommerce.module.css";

const ShopJobPanel = lazy(() =>
  import("./shop-job.js").then(({ ShopJobPanel }) => ({ default: ShopJobPanel })),
);
const WooProblem = lazy(() =>
  import("./woo-problem.js").then(({ WooProblem }) => ({ default: WooProblem })),
);

/**
 * The connection's state, and beside it the small action that ends it. One
 * press does not disconnect: the first opens what disconnecting does, and the
 * button there is the second. A refusal opens it again where it was asked.
 */
function Status({
  connection,
  view,
  base,
  job,
}: Readonly<{
  connection: ConnectionView;
  view: WooShopView;
  base: string;
  job: ShopJobView | null;
}>) {
  return (
    <div className={styles.status}>
      <p className={styles.state}>
        <Word word={job?.words.connectionState ?? connection.state} />
        <span className={styles.shop}>{connection.shop}</span>
        {job?.words.connectionState ? null : (
          <span className={styles.since}>
            since <Moment at={connection.connectedAt} />
          </span>
        )}
      </p>
      <details className={styles.disconnect} open={view.leaving !== null}>
        <summary>
          <span className={styles.closed}>Disconnect</span>
          <span className={styles.opened}>Cancel</span>
        </summary>
        <div className={styles.confirm}>
          {view.leaving === null ? null : (
            <Suspense fallback={<p className="problem">{view.leaving.says}</p>}>
              <WooProblem said={view.leaving} base={base} />
            </Suspense>
          )}
          <p>{connection.disconnectPrompt}</p>
          <ShopForm action="/woocommerce/disconnect" className={styles.confirmPress}>
            {(pending) => (
              <>
                <input type="hidden" name="shop" value={connection.shopUrl} autoComplete="off" />
                <Button variant="secondary" pending={pending}>
                  <span className={styles.leave}>Disconnect shop</span>
                </Button>
              </>
            )}
          </ShopForm>
        </div>
      </details>
    </div>
  );
}

const ConnectionSettings = lazy(() =>
  import("./woo-read-only.js").then(({ ConnectionSettings }) => ({ default: ConnectionSettings })),
);
const ReconnectShop = lazy(() =>
  import("./woo-read-only.js").then(({ ReconnectShop }) => ({ default: ReconnectShop })),
);
const SitePanel = lazy(() =>
  import("./woo-read-only.js").then(({ SitePanel }) => ({ default: SitePanel })),
);

/** Why Import is held, in a line under it, with the page that puts it right. */
function HeldLine({ held, base }: Readonly<{ held: ImportHeld; base: string }>) {
  return (
    <p className="quiet">
      {held.says}
      {held.kind === "settings" ? (
        <>
          {" "}
          <a href={`${base}/settings`}>Settings</a> first.
        </>
      ) : null}
    </p>
  );
}

export function Connected({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  const onboarding = useContext(ProductsShop);
  const account = useContext(ShopAccount);
  const { rate } = connection;
  const site = connection.site;
  const needsSite = site !== null && site.kind !== "saved";
  const header = (job: ShopJobView | null) => (
    <>
      <Status connection={connection} view={view} base={base} job={job} />
      {account.view !== undefined &&
      (account.view.publicationPending ||
        account.view.step.account !== "none" ||
        account.press?.problem) &&
      (job === null ||
        job.status === "queued" ||
        job.status === "running" ||
        !job.current ||
        job.stopCode === "reconnect") ? (
        <OnboardingAccount view={account.view} job={job} press={account.press} />
      ) : null}
      {connection.access !== "read_write" || site === null ? null : site.kind === "saved" ? (
        <p className={styles.site}>
          Buyers' agents will see {site.origin} as your shop's site.{" "}
          <a href={`${base}/settings`}>Change it in Settings</a>.
        </p>
      ) : (
        <Suspense fallback={null}>
          <SitePanel site={site} base={base} />
        </Suspense>
      )}
      {connection.access === "read_write" && !connection.onCode && connection.importing !== null ? (
        <Suspense fallback={<p className="problem">{connection.importing.says}</p>}>
          <WooProblem said={connection.importing} base={base} />
        </Suspense>
      ) : null}
    </>
  );
  return (
    <>
      {connection.access === "read_write" && !connection.onCode ? (
        <Suspense fallback={null}>
          <ShopJobPanel
            header={header}
            initial={view.job ?? null}
            secondaryCheck={needsSite}
            endpoint={`${base}/shop-job`}
            // Products enters this onboarding branch only for an empty unfiltered catalogue.
            noProducts={onboarding}
            {...(account.view?.publicationPending
              ? { notification: account.view.account?.publication.notification }
              : { checkAction: onboarding ? "/products?woo=check" : "/woocommerce/check" })}
            reconnect={
              <Suspense fallback={null}>
                <ReconnectShop connection={connection} />
              </Suspense>
            }
            rate={(job) =>
              rate !== null || job.initialRate === null ? null : (
                <Suspense fallback={null}>
                  <RatePanel rate={job.initialRate} />
                </Suspense>
              )
            }
            publish={(job) =>
              account.view !== undefined &&
              (account.view.publicationPending ||
                account.view.step.account !== "none" ||
                account.press?.problem) ? (
                <OnboardingAccount
                  view={account.view}
                  job={job}
                  press={account.press}
                  publish={
                    job.kind === "check" && job.current && job.ready > 0 && !needsSite
                      ? { checkedJob: job.id, label: job.words.publish }
                      : undefined
                  }
                />
              ) : (job.kind === "publish" || job.ready > 0) && !needsSite ? (
                <>
                  <ShopForm action="/woocommerce/import">
                    {(pending) => (
                      <>
                        <input type="hidden" name="checked_job" value={job.id} />
                        <Button pending={pending} disabled={connection.held !== null}>
                          {job.words.publish}
                        </Button>
                      </>
                    )}
                  </ShopForm>
                  {connection.held === null ? null : (
                    <HeldLine held={connection.held} base={base} />
                  )}
                </>
              ) : null
            }
          />
        </Suspense>
      ) : (
        header(null)
      )}
      {connection.access !== "read_write" || (connection.onCode && !needsSite) ? (
        <Suspense
          fallback={
            connection.access !== "read_write" ? (
              <p role="status">Loading connection settings…</p>
            ) : null
          }
        >
          <ConnectionSettings connection={connection} view={view} base={base} />
        </Suspense>
      ) : !connection.onCode && rate !== null ? (
        <Suspense fallback={null}>
          <RatePanel rate={rate} />
        </Suspense>
      ) : null}
    </>
  );
}
