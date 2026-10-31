import type { ShopJobView } from "../../src/shop-job-view.js";

export function ShopJobOutcome({
  view,
  compact = false,
  noProducts = false,
}: Readonly<{ view: ShopJobView; compact?: boolean; noProducts?: boolean }>) {
  const { words } = view;
  const outcome = (noProducts && words.emptyOutcome) || words.outcome;
  return (
    <>
      {outcome ? (
        <p>
          {outcome}
          {!compact && words.outcomeDetail ? ` ${words.outcomeDetail}` : null}
        </p>
      ) : null}
      {words.publicationUnknown ? <p>{words.publicationUnknown}</p> : null}
      {view.why ? <p>{view.why}</p> : null}
      {words.earlier ? <p>{words.earlier}</p> : null}
    </>
  );
}

export function ShopJobSyncNote({ view }: Readonly<{ view: ShopJobView }>) {
  return <p>{view.words.sync}</p>;
}
