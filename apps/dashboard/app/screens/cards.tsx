import { Button, Table } from "@agentify/ui";
import { Fragment } from "react";
import type { CardAside, CardControl, CardsView } from "../../src/views.js";
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

/**
 * A break before each separator, so a wrapped address breaks between its parts
 * rather than mid-word; zero-width rather than a soft hyphen, so a copied
 * address is the address.
 */
const Wrappable = ({ parts }: Readonly<{ parts: readonly string[] }>) => (
  <>
    {parts.map((part, at) =>
      at === 0 ? (
        part
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one address never reorder
        <Fragment key={at}>
          <wbr />
          {part}
        </Fragment>
      ),
    )}
  </>
);

/** The switches post to a page still served as a string, so with a whole page load. */
const Control = ({
  id,
  control,
  base,
}: Readonly<{ id: string; control: CardControl; base: string }>) => {
  if (control.kind === "switch") {
    return (
      <PostForm
        document
        className="inline"
        action={`/cards/${encodeURIComponent(id)}/${control.verb}`}
      >
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
            <PostForm document className="inline" action={`/selling/${allSelling.verb}`}>
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
                    <div className="buy">
                      <Wrappable parts={row.buy} />
                    </div>
                  </>
                ),
              },
              { className: "key", content: row.itemId },
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
        {
          // Text, not a link: asking for this address without paying is
          // answered with a payment demand in a header, so a browser shows a
          // blank page and the card looks broken.
          "The line under each product is the address an agent buys it at. It is meant for an agent or a test from a terminal: without payment it returns a payment request, not a web page. A card that is off sale cannot be bought there."
        }
      </p>
    </>
  );
}
