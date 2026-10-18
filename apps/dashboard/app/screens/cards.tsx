import { Button, Table } from "@agentify/ui";
import type { CardAside, CardControl, CardsView } from "../../src/views.js";
import { CodeCopy } from "../components/copy.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Rest } from "../components/rest.js";
import { Word } from "../components/word.js";

const Aside = ({ aside }: Readonly<{ aside: CardAside }>) =>
  "facts" in aside ? (
    aside.facts
  ) : (
    <>
      Price on the card since <Moment at={aside.since} />
    </>
  );

const Control = ({
  id,
  control,
  base,
}: Readonly<{ id: string; control: CardControl; base: string }>) => {
  if (control.kind === "switch") {
    return (
      <PostForm className="inline" action={`/cards?${new URLSearchParams({ [control.verb]: id })}`}>
        {(pending) => (
          <Button
            compact
            variant={control.verb === "resume" ? "primary" : "secondary"}
            pending={pending}
          >
            {control.verb === "resume" ? "Resume" : "Pause"}
          </Button>
        )}
      </PostForm>
    );
  }
  if (control.kind === "unset") {
    return (
      <span className="quiet">
        Not on sale until you set {control.what} in <a href={`${base}/settings`}>Settings</a>.
        {control.waiting}
      </span>
    );
  }
  return <span className="quiet">{control.text}</span>;
};

export function CardsScreen({ view, base }: Readonly<{ view: CardsView; base: string }>) {
  const { allSelling } = view;
  return (
    <>
      <div className="lede">
        <div>
          <div className="stat-pills">
            <span className="stat-pill">
              Published <b>{view.published}</b>
            </span>
            <span className="stat-pill">
              Paused by you <b>{view.pausedByYou}</b>
            </span>
          </div>
        </div>
        <div className="actions">
          {allSelling === null ? null : (
            <PostForm className="inline" action={`/cards?selling=${allSelling.verb}`}>
              {(pending) => (
                <Button
                  variant={allSelling.verb === "resume" ? "primary" : "secondary"}
                  pending={pending}
                >
                  {allSelling.label}
                </Button>
              )}
            </PostForm>
          )}
        </div>
      </div>
      {view.empty === null ? (
        <Table
          columns={["Product", "Product code", "Price", "Delivery", "State", ""]}
          empty=""
          rows={view.rows.map((row) => ({
            key: row.id,
            ...(row.off ? { className: "off" } : {}),
            cells: [
              {
                content: (
                  <>
                    <div className="title">{row.title}</div>
                    <div className="under">
                      <Aside aside={row.aside} />
                    </div>
                  </>
                ),
              },
              { className: "key", content: <CodeCopy code={row.itemId} address={row.buy} /> },
              { className: "amount", content: row.price },
              { className: "quiet", content: row.delivery },
              { content: <Word word={row.state} /> },
              {
                className: "control",
                content: <Control id={row.id} control={row.control} base={base} />,
              },
            ],
          }))}
        />
      ) : (
        <div className="empty-start">
          <p>{view.empty.why}</p>
          <div className="connect-actions">
            <a className="button button-primary" href="/docs/quickstart">
              Publish your first card through the SDK
            </a>
            {view.empty.woo ? (
              <a className="button button-secondary" href={`${base}/woocommerce`}>
                Connect a WooCommerce shop
              </a>
            ) : null}
          </div>
        </div>
      )}
      <p className="note">
        {view.sellingNote}
        <Rest rest={view.sellingRest} />
      </p>
      <p className="note">
        The link icon beside a product code copies the address an agent buys the card at. It is
        meant for an agent or a test from a terminal: without payment it returns a payment request,
        not a web page. A card that is off sale cannot be bought there.
      </p>
    </>
  );
}
