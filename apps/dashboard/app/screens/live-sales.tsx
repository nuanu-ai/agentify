import { Badge, Button, Field } from "@agentify/ui";
import type { LiveSalesView } from "../../src/live-sales.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import styles from "./live-sales.module.css";
import orders from "./orders.module.css";

export function LiveSalesScreen({ view }: Readonly<{ view: LiveSalesView }>) {
  const merchant = view.merchant;
  const approved = merchant?.approvedAt != null;
  if (!view.live) {
    return (
      <div className="lede">
        <div>
          <p>
            Test sales need no approval. Open the live site's admin screen to approve real sales.
          </p>
        </div>
      </div>
    );
  }
  // A message beside a merchant just approved is the approval's own; any other
  // is a refusal, said under the press it answers.
  const refusal = approved ? null : view.message;
  const searchRefused = merchant === null ? refusal : null;
  const approvalRefused = merchant === null ? null : refusal;
  return (
    <>
      <div className="lede">
        <div>
          <p>Review a merchant and allow them to sell for real money.</p>
        </div>
      </div>
      <div className={`settings-grid ${styles.layout}`}>
        <section className="settings-panel" aria-labelledby="find-merchant">
          <div className="lede">
            <div>
              <h2 id="find-merchant">Find a merchant</h2>
              <p>By the email they sign in to Agentify with.</p>
            </div>
          </div>
          <PostForm action="/admin/live-sales" document className="issue">
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
          {searchRefused === null ? null : (
            <div className="panel-messages">
              <p className="problem" role="alert">
                {searchRefused}
              </p>
            </div>
          )}
        </section>
        <section className={`settings-panel ${styles.panel}`} aria-labelledby="merchant-details">
          <div className="lede">
            <div>
              <h2 id="merchant-details" className={styles.heading}>
                {merchant?.name ?? (merchant === null ? "Merchant details" : "Seller name not set")}
                {merchant === null ? null : (
                  <Badge tone={approved ? "pass" : "notice"}>
                    {approved ? "Approved" : "Not approved"}
                  </Badge>
                )}
              </h2>
              {merchant === null ? (
                <p>Find a merchant to see their account. Finding one changes nothing.</p>
              ) : null}
            </div>
          </div>
          {merchant === null ? null : (
            <>
              <dl className={`${orders.facts} ${styles.facts}`}>
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
                    <dt>Approved</dt>
                    <dd>
                      <Moment at={merchant.approvedAt} />
                    </dd>
                  </div>
                )}
              </dl>
              {approved ? (
                <div className="panel-messages">
                  {view.message === null ? null : <p role="status">{view.message}</p>}
                  <p className="quiet">
                    Seller name, payout wallet and integration are still required before selling.
                  </p>
                </div>
              ) : (
                <PostForm action="/admin/live-sales" document className={styles.confirm}>
                  {(pending) => (
                    <>
                      <input type="hidden" name="intent" value="approve" />
                      <input type="hidden" name="email" value={merchant.email} />
                      <input type="hidden" name="merchant_id" value={merchant.id} />
                      <label className={styles.check}>
                        <input type="checkbox" name="confirm" value="live-sales" required />
                        <span>Allow this merchant to sell for real money.</span>
                      </label>
                      <p className="quiet">
                        This cannot be undone. Seller name, payout wallet and integration are still
                        required before selling.
                      </p>
                      <Button pending={pending}>Approve live sales</Button>
                      {approvalRefused === null ? null : (
                        <p className="problem" role="alert">
                          {approvalRefused}
                        </p>
                      )}
                    </>
                  )}
                </PostForm>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
