import { Button } from "@agentify/ui";
import { Link } from "react-router";
import type { OnboardingView } from "../../src/onboarding.js";
import type { ShopJobView } from "../../src/shop-job-view.js";
import { PostForm } from "../components/post-form.js";
import styles from "./shop-job.module.css";
import { useShopJob } from "./shop-job-observer.js";
import { ShopJobOutcome, ShopJobSyncNote } from "./shop-job-outcome.js";
import { ShopJobProgress } from "./shop-job-progress.js";

/** The catalogue keeps the result's next action; product groups belong to the shop detail. */
export function ShopJobSummary({
  initial,
  endpoint,
  summaryTo,
  checkAction,
  publication,
  noProducts = false,
}: Readonly<{
  publication?: NonNullable<OnboardingView["account"]>["publication"];
  initial: ShopJobView | null;
  endpoint: string;
  summaryTo: string;
  checkAction: string;
  noProducts?: boolean;
}>) {
  const [view, unread] = useShopJob(initial, endpoint);
  if (!view || view.status === "queued" || view.status === "running")
    return <ShopJobProgress view={view} unread={unread} notification={publication?.notification} />;
  if (publication) return <p role="status">{publication.waiting}</p>;
  const problem = unread ? (
    <p role="status">Progress couldn't be refreshed. The server may still be working.</p>
  ) : null;
  if (view.current && view.status === "completed") {
    const fix = view.words.fix;
    if (fix === null) return problem;
    return (
      <section className={styles.job} aria-label="Shop products">
        <p>
          {fix.lead} <Link to={summaryTo}>{fix.action}</Link>.
        </p>
        {problem}
      </section>
    );
  }
  const recovery =
    view.current && (view.stopCode === "rate_required" || view.stopCode === "reconnect");
  const sync = view.current && view.kind === "publish" && !recovery;
  return (
    <section className={styles.job} aria-label="Shop products">
      <ShopJobOutcome view={view} compact noProducts={noProducts} />
      {sync ? (
        <>
          <ShopJobSyncNote view={view} />
          <PostForm action="/products?woo=import">
            {(pending) => (
              <>
                <input type="hidden" name="checked_job" value={view.id} />
                <Button pending={pending}>{view.words.publish}</Button>
              </>
            )}
          </PostForm>
        </>
      ) : recovery ? (
        <Link className="button button-primary" to={summaryTo}>
          {view.stopCode === "rate_required" ? "Set your exchange rate" : "Reconnect your shop"}
        </Link>
      ) : (
        <PostForm action={checkAction}>
          {(pending) => <Button pending={pending}>Check again</Button>}
        </PostForm>
      )}
      {problem}
    </section>
  );
}
