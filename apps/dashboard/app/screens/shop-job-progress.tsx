import type { CSSProperties } from "react";
import type { ShopJobView } from "../../src/shop-job-view.js";
import styles from "./shop-job.module.css";

/** Shown wherever a job's last read failed; one copy, since every shop screen loads this module. */
export const progressUnread = (
  <p role="status">Progress couldn't be refreshed. The server may still be working.</p>
);

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
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={view.total ?? undefined}
        aria-valuenow={view.total === null ? undefined : view.read}
        aria-valuetext={view.words.progress}
        aria-label="Products read"
      >
        <span
          style={
            {
              "--read":
                view.total === null
                  ? undefined
                  : `${Math.min(100, view.total === 0 ? 0 : (view.read / view.total) * 100)}%`,
            } as CSSProperties
          }
        />
      </div>
      <p>{notification ?? view.words.leaving}</p>
      {unread ? progressUnread : null}
    </section>
  );
}
