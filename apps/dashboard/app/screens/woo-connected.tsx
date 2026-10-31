import { Button, Field } from "@agentify/ui";
import { lazy, Suspense, useContext } from "react";
import type { ShopJobView } from "../../src/shop-job-view.js";
import type { ConnectionView, ImportHeld, RateView, WooShopView } from "../../src/woo-views.js";
import { Fact, Facts } from "../components/list.js";
import { Moment } from "../components/moment.js";
import { Word } from "../components/word.js";
import { PanelHead } from "../display/panel-head.js";
import { ProductsShop, ShopForm } from "./shop-context.js";
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

const ReadOnlyPanel = lazy(() =>
  import("./woo-read-only.js").then(({ ReadOnlyPanel }) => ({ default: ReadOnlyPanel })),
);

const SwitchPanel = lazy(() =>
  import("./woo-read-only.js").then(({ SwitchPanel }) => ({ default: SwitchPanel })),
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

/**
 * The rate of a shop priced in another currency: the merchant's own, and
 * Coinbase's open rate beside it, which catches a mistyped rate and prices
 * nothing. A rate far from it is asked for a second time.
 */
function RatePanel({ rate }: Readonly<{ rate: RateView }>) {
  const { current, reference } = rate;
  return (
    <section className="settings-panel">
      <PanelHead
        title="Exchange rate"
        said={
          <>
            {rate.saved === null ? null : <p className={styles.saved}>{rate.saved}</p>}
            {rate.refused === null ? null : <p className="problem">{rate.refused}</p>}
            {reference.kind === "unlisted" ? (
              <p className="problem">{rate.words.unlisted}</p>
            ) : null}
          </>
        }
      >
        <p>{rate.words.explanation}</p>
      </PanelHead>
      {current === null ? null : (
        <div className={styles.facts}>
          <Facts>
            <Fact label="Your rate">
              <span className={current.far ? styles.far : undefined}>{rate.words.yourRate}</span>
            </Fact>
            <Fact label="Saved">
              <Moment at={current.setAt} />
              {current.sessionSignedInAt === null ? (
                rate.words.noSession
              ) : (
                <>
                  {rate.words.sessionLead}
                  <Moment at={current.sessionSignedInAt} />
                  {rate.words.sessionTail}
                </>
              )}
            </Fact>
            {reference.kind === "read" ? (
              <Fact label="Coinbase">
                {rate.words.referenceRate} <Moment at={reference.readAt} />
              </Fact>
            ) : reference.kind === "unread" ? (
              <Fact label="Coinbase">{rate.words.unavailable}</Fact>
            ) : null}
          </Facts>
        </div>
      )}
      {current !== null && reference.kind === "not_requested" ? <p>{rate.words.pending}</p> : null}
      {reference.kind === "unlisted" ? null : (
        <ShopForm
          action="/woocommerce/rate"
          className={rate.again === null ? `issue ${styles.row}` : styles.again}
        >
          {(pending) => (
            <>
              <input type="hidden" name="currency" value={rate.currency} autoComplete="off" />
              <Field
                label={rate.words.field}
                name="rate"
                inputMode="decimal"
                defaultValue={rate.typed === "" ? (current?.raw ?? "") : rate.typed}
                {...(rate.problem === null ? {} : { error: rate.problem })}
                {...(current === null ? { hint: rate.words.hint } : {})}
                required
              />
              {rate.again === null ? null : (
                <>
                  <p className={styles.check}>{rate.again}</p>
                  <Field label="Type the rate again" name="again" inputMode="decimal" required />
                </>
              )}
              <Button pending={pending} variant={current === null ? "primary" : "secondary"}>
                Save rate
              </Button>
            </>
          )}
        </ShopForm>
      )}
    </section>
  );
}

export function Connected({
  connection,
  view,
  base,
}: Readonly<{ connection: ConnectionView; view: WooShopView; base: string }>) {
  const onboarding = useContext(ProductsShop);
  const { rate } = connection;
  const site = connection.site;
  const needsSite = site !== null && site.kind !== "saved";
  const header = (job: ShopJobView | null) => (
    <>
      <Status connection={connection} view={view} base={base} job={job} />
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
            checkAction={onboarding ? "/products?woo=check" : "/woocommerce/check"}
            reconnect={
              <ShopForm action="/woocommerce/connect">
                {(pending) => (
                  <>
                    <input
                      type="hidden"
                      name="checked_shop"
                      value={connection.shopUrl}
                      autoComplete="off"
                    />
                    <input
                      type="hidden"
                      name="shop_url"
                      value={connection.shopUrl}
                      autoComplete="off"
                    />
                    <Button pending={pending}>Connect again</Button>
                  </>
                )}
              </ShopForm>
            }
            rate={(job) =>
              rate !== null || job.initialRate === null ? null : (
                <RatePanel rate={job.initialRate} />
              )
            }
            publish={(job) =>
              job.ready > 0 && !needsSite ? (
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
      {connection.access !== "read_write" ? (
        <Suspense fallback={<p role="status">Loading connection settings…</p>}>
          <ReadOnlyPanel connection={connection} view={view} base={base} />
        </Suspense>
      ) : connection.onCode ? (
        needsSite ? null : (
          <div className="settings-grid">
            <Suspense fallback={null}>
              <SwitchPanel connection={connection} view={view} base={base} />
            </Suspense>
            {rate === null ? null : <RatePanel rate={rate} />}
          </div>
        )
      ) : rate === null ? null : (
        <RatePanel rate={rate} />
      )}
    </>
  );
}
