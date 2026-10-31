import { Button } from "@agentify/ui";
import { type ReactNode, useId } from "react";
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
  readonly publish?: (view: ShopJobView, checkAgain: ReactNode) => ReactNode;
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
  const checked = (secondary: boolean) => (
    <span className={styles.checked}>
      <span>
        Checked <Moment at={view.when} />
      </span>
      {checkAction ? (
        <CheckButton form={formId} action={checkAction} secondary={secondary} />
      ) : null}
    </span>
  );
  const nextStep =
    view.current && currentStop !== "reconnect" ? publish?.(view, checked(true)) : null;
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
      {checkAction ? (
        <PostForm id={formId} className={styles.checkForm} action={checkAction}>
          {() => null}
        </PostForm>
      ) : null}
      {currentStop === "reconnect" ? (reconnect ?? <p>{view.words.reconnectInstruction}</p>) : null}
      {nextStep}
      {currentStop !== "reconnect" && !hasNextStep ? (
        <div className="step-actions">{checked(view.current && secondaryCheck === true)}</div>
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
              <List
                label={`${group.title}${reason.why ? `: ${reason.why}` : ""}`}
                columns="minmax(0, 1fr)"
              >
                {reason.rows.map((row) => (
                  <Row key={row.id}>
                    <Cell at="title">{row.title}</Cell>
                    {row.why ? <Cell at="note">{row.why}</Cell> : null}
                  </Row>
                ))}
              </List>
              {reason.more ? <Link to={reason.more.href}>{reason.more.label}</Link> : null}
            </div>
          ))}
        </section>
      ))}
    </section>
  );
}
