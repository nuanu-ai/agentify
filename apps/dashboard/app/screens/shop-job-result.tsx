import { Button } from "@agentify/ui";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ShopJobView } from "../../src/shop-job-view.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import styles from "./shop-job.module.css";

import { ShopJobOutcome, ShopJobSyncNote } from "./shop-job-outcome.js";

interface ShopJobResultProps {
  readonly view: ShopJobView;
  readonly unread: boolean;
  readonly reconnect?: ReactNode;
  readonly secondaryCheck?: boolean;
  readonly checkAction?: string;
  readonly publish?: (view: ShopJobView) => ReactNode;
  readonly rate?: (view: ShopJobView) => ReactNode;
  readonly noProducts?: boolean;
}
export function ShopJobResult({
  view,
  unread,
  reconnect,
  secondaryCheck,
  checkAction,
  publish,
  rate,
  noProducts,
}: ShopJobResultProps) {
  const currentStop = view.current ? view.stopCode : null;
  if (currentStop === "rate_required" && rate) return <>{rate(view)}</>;
  const nextStep = view.current && currentStop !== "reconnect" ? publish?.(view) : null;
  const hasNextStep = nextStep !== null && nextStep !== undefined && nextStep !== false;
  return (
    <section className={styles.job} aria-label="Shop products">
      <h2>{view.words.heading}</h2>
      <ShopJobOutcome view={view} noProducts={noProducts} />
      {view.words.excluded ? <p>{view.words.excluded}</p> : null}
      {view.current && view.status === "stopped" && view.kind === "check" && view.read > 0 ? (
        <h3>{view.words.summary}</h3>
      ) : null}
      {view.kind === "publish" ? <ShopJobSyncNote view={view} /> : null}
      {currentStop === "reconnect" ? (reconnect ?? <p>{view.words.reconnectInstruction}</p>) : null}
      {nextStep}
      {currentStop !== "reconnect" ? (
        <div className={styles.checked}>
          <p>
            Checked <Moment at={view.when} />
          </p>
          {checkAction ? (
            <PostForm action={checkAction}>
              {(pending) => (
                <Button
                  variant={
                    hasNextStep || (view.current && secondaryCheck) ? "secondary" : "primary"
                  }
                  pending={pending}
                >
                  Check again
                </Button>
              )}
            </PostForm>
          ) : null}
        </div>
      ) : null}
      {unread ? (
        <p role="status">Progress couldn't be refreshed. The server may still be working.</p>
      ) : null}
      {view.groups.map((group) => (
        <section key={group.group} className={styles.group}>
          <h3>
            {group.title} <span>{group.countText}</span>
          </h3>
          {group.group === "unsupported" ? (
            <p>
              Agentify can't sell <a href="/docs/woocommerce#what-can-be-imported">these yet</a>.
            </p>
          ) : null}
          {group.reasons.map((reason) => (
            <div key={reason.code}>
              {reason.why ? (
                <p>
                  {reason.why} <span>({reason.countText})</span>
                </p>
              ) : null}
              <ul>
                {reason.rows.map((row) => (
                  <li key={row.id}>
                    {row.title}
                    {row.why ? <span className="quiet"> · {row.why}</span> : null}
                  </li>
                ))}
              </ul>
              {reason.more ? <Link to={reason.more.href}>{reason.more.label}</Link> : null}
            </div>
          ))}
        </section>
      ))}
    </section>
  );
}
