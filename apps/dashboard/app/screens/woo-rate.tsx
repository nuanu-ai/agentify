import { Button, Field } from "@agentify/ui";
import type { RateView } from "../../src/woo-views.js";
import { Fact, Facts } from "../components/list.js";
import { Moment } from "../components/moment.js";
import { PanelHead } from "../display/panel-head.js";
import { ShopForm } from "./shop-context.js";
import styles from "./woocommerce.module.css";

/**
 * The rate of a shop priced in another currency: the merchant's own, and
 * Coinbase's open rate beside it, which catches a mistyped rate and prices
 * nothing. A rate far from it is asked for a second time.
 */
export function RatePanel({ rate }: Readonly<{ rate: RateView }>) {
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
