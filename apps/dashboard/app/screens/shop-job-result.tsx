import { Button } from "@agentify/ui";
import { Fragment, type ReactNode, useId } from "react";
import { Link, useNavigation } from "react-router";
import type { ShopJobView } from "../../src/shop-job-view.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Cell, List, Row } from "../display/list.js";
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
function CheckButton({
  action,
  form,
  secondary,
}: Readonly<{ action: string; form: string; secondary: boolean }>) {
  const navigation = useNavigation();
  const pending = navigation.state !== "idle" && navigation.formAction?.endsWith(action) === true;
  return (
    <Button form={form} variant={secondary ? "secondary" : "primary"} pending={pending}>
      Check again
    </Button>
  );
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
  const formId = useId();
  const currentStop = view.current ? view.stopCode : null;
  if (currentStop === "rate_required" && rate) return <>{rate(view)}</>;
  const nextStep = view.current && currentStop !== "reconnect" ? publish?.(view) : null;
  const hasNextStep = nextStep !== null && nextStep !== undefined && nextStep !== false;
  return (
    <section className={styles.job} aria-label="Shop products">
      <div>
        <h2>{view.words.heading}</h2>
        <ShopJobOutcome view={view} noProducts={noProducts} />
        {view.words.excluded ? <p>{view.words.excluded}</p> : null}
        {view.current && view.status === "stopped" && view.kind === "check" && view.read > 0 ? (
          <p>{view.words.summary}</p>
        ) : null}
        {view.kind === "publish" ? <ShopJobSyncNote view={view} /> : null}
      </div>
      {checkAction ? (
        <PostForm id={formId} action={checkAction}>
          {() => null}
        </PostForm>
      ) : null}
      {currentStop === "reconnect" ? (reconnect ?? <p>{view.words.reconnectInstruction}</p>) : null}
      {nextStep}
      {unread ? (
        <p role="status">Progress couldn't be refreshed. The server may still be working.</p>
      ) : null}
      {currentStop === "reconnect" && view.groups.length === 0 ? null : (
        <div className={styles.products}>
          {currentStop === "reconnect" ? null : (
            <div>
              <span>
                Checked <Moment at={view.when} />
              </span>
              {checkAction ? (
                <CheckButton
                  form={formId}
                  action={checkAction}
                  secondary={hasNextStep || (view.current && secondaryCheck === true)}
                />
              ) : null}
            </div>
          )}
          {view.groups.map((group) => (
            <div key={group.group} className="list">
              <div className="list-day">
                <h3>
                  {group.title} <span>{group.countText}</span>
                </h3>
                {group.group === "unsupported" ? (
                  <a href="/docs/woocommerce#what-can-be-imported">What Agentify can sell</a>
                ) : null}
              </div>
              {group.reasons.map((reason) => (
                <Fragment key={reason.code}>
                  {reason.why ? (
                    <div className="list-day">
                      <h4>{reason.why}</h4>
                      <span>{reason.countText}</span>
                    </div>
                  ) : null}
                  <List
                    label={reason.why ? `${group.title}: ${reason.why}` : group.title}
                    columns="minmax(0, 1fr) fit-content(40%)"
                  >
                    {reason.rows.map((row) => (
                      <Row key={row.id}>
                        <Cell at="title">{row.title}</Cell>
                        {row.why ? <Cell at="note">{row.why}</Cell> : null}
                      </Row>
                    ))}
                  </List>
                  {reason.more ? <Link to={reason.more.href}>{reason.more.label}</Link> : null}
                </Fragment>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
