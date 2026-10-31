import type { ReactNode } from "react";
import type { ShopJobView } from "../../src/shop-job-view.js";
import { useShopJob } from "./shop-job-observer.js";
import { ShopJobProgress } from "./shop-job-progress.js";

import { ShopJobResult } from "./shop-job-result.js";

/** Observe progress in place; completed publications refresh the surrounding catalog once. */
export function ShopJobPanel({
  initial,
  endpoint,
  checkAction,
  publish,
  rate,
  reconnect,
  secondaryCheck = false,
  header,
  noProducts = false,
}: Readonly<{
  noProducts?: boolean;
  header?: (view: ShopJobView | null) => ReactNode;
  reconnect?: ReactNode;
  secondaryCheck?: boolean;
  initial: ShopJobView | null;
  endpoint: string;
  checkAction?: string;
  publish?: (view: ShopJobView) => ReactNode;
  rate?: (view: ShopJobView) => ReactNode;
}>) {
  const [view, unread] = useShopJob(initial, endpoint);
  return (
    <>
      {header?.(view)}
      {!view || view.status === "queued" || view.status === "running" ? (
        <ShopJobProgress view={view} unread={unread} />
      ) : (
        <ShopJobResult
          view={view}
          unread={unread}
          reconnect={reconnect}
          secondaryCheck={secondaryCheck}
          checkAction={checkAction}
          publish={publish}
          rate={rate}
          noProducts={noProducts}
        />
      )}
    </>
  );
}
