import { Button } from "@agentify/ui";
import type { CardAside, CardControl, CardsView } from "../../src/views.js";
import { CodeCopy } from "../components/copy.js";
import { Cell, List, Row, RowMore } from "../components/list.js";
import { CutNote, ListTools, NothingHere } from "../components/listing.js";
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

/** The control that stops or restarts all selling, where the merchant has one. */
const AllSelling = ({ allSelling }: Readonly<{ allSelling: CardsView["allSelling"] }>) =>
  allSelling === null ? null : (
    <PostForm className="inline" action={`/cards?selling=${allSelling.verb}`}>
      {(pending) => (
        <Button variant={allSelling.verb === "resume" ? "primary" : "secondary"} pending={pending}>
          {allSelling.label}
        </Button>
      )}
    </PostForm>
  );

export function CardsScreen({ view, base }: Readonly<{ view: CardsView; base: string }>) {
  const { allSelling, listing, empty } = view;
  const notes = (
    <>
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
  if (empty !== null) {
    return (
      <>
        <div className="lede">
          <div />
          <div className="actions">
            <AllSelling allSelling={allSelling} />
          </div>
        </div>
        <div className="empty-start">
          <p>{empty.why}</p>
          <div className="connect-actions">
            <a className="button button-primary" href="/docs/quickstart">
              Publish your first card through the SDK
            </a>
            {empty.woo ? (
              <a className="button button-secondary" href={`${base}/woocommerce`}>
                Connect a WooCommerce shop
              </a>
            ) : null}
          </div>
        </div>
        {notes}
      </>
    );
  }
  return (
    <>
      <ListTools
        listing={listing}
        path="/cards"
        label="Search cards"
        placeholder="Search by name or product code"
      >
        <AllSelling allSelling={allSelling} />
      </ListTools>
      {listing.rows.length === 0 ? (
        <NothingHere listing={listing} />
      ) : (
        <List
          label="Product cards"
          columns="minmax(12rem, 1fr) 7rem 9rem 9rem minmax(6rem, 15rem)"
          head={["Product", { text: "Price", end: true }, "Delivery", "State", ""]}
        >
          {listing.rows.map((row) => (
            <Row key={row.id} off={row.off}>
              <Cell at="main">
                <Cell at="title">{row.title}</Cell>
                <Cell at="aside">
                  <Aside aside={row.aside} />
                </Cell>
                <Cell at="ident">
                  <CodeCopy code={row.itemId} address={row.buy} />
                </Cell>
              </Cell>
              <Cell at="amount">{row.price}</Cell>
              <Cell at="fact">{row.delivery}</Cell>
              <Cell at="state">
                <Word word={row.state} />
              </Cell>
              <Cell at={row.control.kind === "switch" ? "action" : "note"}>
                <Control id={row.id} control={row.control} base={base} />
              </Cell>
              <RowMore summary="Price and delivery">
                <Aside aside={row.aside} />
              </RowMore>
            </Row>
          ))}
        </List>
      )}
      <CutNote cut={listing.cut} />
      {notes}
    </>
  );
}
