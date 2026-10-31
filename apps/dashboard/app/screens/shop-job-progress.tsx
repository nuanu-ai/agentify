import type { ShopJobView } from "../../src/shop-job-view.js";
import styles from "./shop-job.module.css";

export function ShopJobProgress({
  view,
  unread,
  notification,
}: Readonly<{ view: ShopJobView | null; unread: boolean; notification?: string }>) {
  if (!view)
    return (
      <p role="status">
        {unread
          ? "Shop progress couldn't be read. We'll try again."
          : "Preparing to check your products…"}
      </p>
    );
  return (
    <section className={styles.job} aria-label="Shop products">
      <h2>{view.words.heading}</h2>
      <p role="status">{view.words.progress}</p>
      <progress
        max={view.total ?? undefined}
        value={view.total === null ? undefined : view.read}
        aria-label="Products read"
      />
      <p>{notification ?? view.words.leaving}</p>
      {unread ? (
        <p role="status">Progress couldn't be refreshed. The server may still be working.</p>
      ) : null}
    </section>
  );
}
