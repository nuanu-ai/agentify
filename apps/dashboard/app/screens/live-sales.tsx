import { Badge, Button, Field } from "@agentify/ui";
import type { LiveSalesView } from "../../src/live-sales.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import styles from "./live-sales.module.css";

export function LiveSalesScreen({ view }: Readonly<{ view: LiveSalesView }>) {
  const merchant = view.merchant;
  const approved = merchant?.approvedAt != null;
  return (
    <>
      <div className="lede">
        <div>
          <p>Review a merchant and allow them to publish products for real-money sales.</p>
        </div>
      </div>
      {!view.live ? (
        <div className={styles.channel}>
          <Badge tone="quiet">No approval needed</Badge>
          <p>
            Test sales need no approval. Open the live site's admin screen to approve real sales.
          </p>
        </div>
      ) : (
        <div className={`settings-grid ${styles.layout}`}>
          <section className={`settings-panel ${styles.panel}`} aria-labelledby="find-merchant">
            <h2 id="find-merchant">Find a merchant</h2>
            <p className="quiet">Use the email they use to sign in to Agentify.</p>
            <PostForm action="/admin/live-sales" document className={styles.search}>
              {(pending) => (
                <>
                  <input type="hidden" name="intent" value="lookup" />
                  <Field
                    label="Seller's account email"
                    id="seller-email"
                    type="email"
                    name="email"
                    defaultValue={view.email}
                    required
                    autoComplete="off"
                  />
                  <Button variant="secondary" pending={pending}>
                    Find merchant
                  </Button>
                </>
              )}
            </PostForm>
            {view.message === null || approved ? null : (
              <div className={`callout ${styles.notice}`} role="alert">
                {view.message}
              </div>
            )}
          </section>
          <section className={`settings-panel ${styles.panel}`} aria-labelledby="merchant-details">
            <div className={styles.heading}>
              <h2 id="merchant-details">
                {merchant?.name ?? (merchant === null ? "Merchant details" : "Seller name not set")}
              </h2>
              {merchant === null ? null : (
                <Badge tone={approved ? "pass" : "notice"}>
                  {approved ? "Approved" : "Not approved"}
                </Badge>
              )}
            </div>
            {merchant === null ? (
              <p className="quiet">
                Find a merchant to review their account and current approval. Searching does not
                change their permission to sell.
              </p>
            ) : (
              <>
                {approved && view.message !== null ? (
                  <p className={styles.success} role="status">
                    {view.message}
                  </p>
                ) : null}
                <dl className={styles.details}>
                  <div>
                    <dt>Account</dt>
                    <dd>{merchant.email}</dd>
                  </div>
                  <div>
                    <dt>Merchant ID</dt>
                    <dd className="mono">{merchant.id}</dd>
                  </div>
                  <div>
                    <dt>Shop website</dt>
                    <dd>
                      {merchant.site === null ? (
                        "Not set"
                      ) : (
                        <a href={merchant.site} target="_blank" rel="noreferrer">
                          {merchant.site}
                        </a>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Integration</dt>
                    <dd>{merchant.integration === "api" ? "SDK / API" : "WooCommerce"}</dd>
                  </div>
                  {merchant.approvedAt === null ? null : (
                    <div>
                      <dt>Approved at</dt>
                      <dd>
                        <Moment at={merchant.approvedAt} />
                      </dd>
                    </div>
                  )}
                </dl>
                {approved ? (
                  <p className={styles.explanation}>
                    The merchant must still meet the seller details, payout wallet and integration
                    requirements before selling.
                  </p>
                ) : (
                  <PostForm action="/admin/live-sales" document className={styles.confirm}>
                    {(pending) => (
                      <>
                        <input type="hidden" name="intent" value="approve" />
                        <input type="hidden" name="email" value={merchant.email} />
                        <input type="hidden" name="merchant_id" value={merchant.id} />
                        <label className={styles.check}>
                          <input type="checkbox" name="confirm" value="live-sales" required />{" "}
                          <span>Allow this merchant to sell for real money.</span>
                        </label>
                        <p className={styles.explanation}>
                          This approval has no undo button. Seller details, payout wallet and
                          integration requirements still apply.
                        </p>
                        <Button pending={pending}>Approve live sales</Button>
                      </>
                    )}
                  </PostForm>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
