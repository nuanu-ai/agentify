import { Button } from "@agentify/ui";
import type { CardControl, CardPrice, CardsView } from "../../src/views.js";
import { CodeCopy } from "../components/copy.js";
import { Cell, List, ListEmpty, Row, RowMore } from "../components/list.js";
import { CutNote, ListTools, NothingHere } from "../components/listing.js";
import { Moment } from "../components/moment.js";
import { PostForm } from "../components/post-form.js";
import { Rest } from "../components/rest.js";
import { Word } from "../components/word.js";
import styles from "./cards.module.css";

type Place = CardsView["listing"]["place"];

/**
 * The list a switch is pressed on, carried in its form, so the press leads
 * back to the search, the segment and the page the merchant was reading.
 */
const Kept = ({ place }: Readonly<{ place: Place }>) =>
  Object.entries(place).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} autoComplete="off" />
  ));

/**
 * Said on the price itself, where a pointer resting on it finds it: on every
 * fixed-price row the line would be the same one, so the row does not print
 * it, and a narrow row's opened part says it in full.
 */
const sinceIn = (priced: Extract<CardPrice, { since: unknown }>): string =>
  `Price on the card since ${"text" in priced.since ? priced.since.text : `${priced.since.date} ${priced.since.time}`}`;

const Since = ({ priced }: Readonly<{ priced: Extract<CardPrice, { since: unknown }> }>) => (
  <>
    Price on the card since <Moment at={priced.since} />
  </>
);

const Control = ({
  id,
  control,
  place,
}: Readonly<{ id: string; control: CardControl; place: Place }>) => {
  if (control.kind === "none") return null;
  if (control.kind === "reason") return <Cell at="note">{control.text}</Cell>;
  return (
    <Cell at="action">
      <PostForm className="inline" action={`/cards?${new URLSearchParams({ [control.verb]: id })}`}>
        {(pending) => (
          <>
            <Kept place={place} />
            <Button
              compact
              variant={control.verb === "resume" ? "primary" : "secondary"}
              pending={pending}
            >
              {control.verb === "resume" ? "Resume" : "Pause"}
            </Button>
          </>
        )}
      </PostForm>
    </Cell>
  );
};

/**
 * The control that stops or restarts all selling, where the merchant has one,
 * for the end of the page's title bar.
 */
export function AllSelling({ view }: Readonly<{ view: CardsView }>) {
  const { allSelling, listing } = view;
  if (allSelling === null) return null;
  return (
    <PostForm className="inline" action={`/cards?selling=${allSelling.verb}`}>
      {(pending) => (
        <>
          <Kept place={listing.place} />
          <Button
            compact
            variant={allSelling.verb === "resume" ? "primary" : "secondary"}
            pending={pending}
          >
            {allSelling.label}
          </Button>
        </>
      )}
    </PostForm>
  );
}

export function CardsScreen({ view, base }: Readonly<{ view: CardsView; base: string }>) {
  const { listing, empty, note } = view;
  if (empty !== null) {
    return (
      <ListEmpty>
        <p>{empty.says}</p>
        <div className={styles.ways}>
          <a className="button button-primary" href="/docs/quickstart">
            Publish a card through the SDK
          </a>
          {empty.woo ? (
            <a className="button button-secondary" href={`${base}/woocommerce`}>
              Connect a WooCommerce shop
            </a>
          ) : null}
        </div>
      </ListEmpty>
    );
  }
  // The last column holds a button, unless a card has a reason of its own to say there.
  const reasoned = listing.rows.some((row) => row.control.kind === "reason");
  return (
    <>
      <ListTools
        listing={listing}
        path="/cards"
        label="Search cards"
        placeholder="Search by name or product code"
      />
      {view.byCode === null || listing.rows.length === 0 ? null : (
        <p className={styles.byCode}>{view.byCode}</p>
      )}
      {listing.rows.length === 0 ? (
        <NothingHere listing={listing} />
      ) : (
        <List
          label="Product cards"
          columns={`minmax(12rem, 1fr) 7rem 12rem 8.5rem ${reasoned ? "minmax(6.5rem, 12rem)" : "6.5rem"}`}
          head={["Product", { text: "Price", end: true }, "Delivery", "State", ""]}
        >
          {listing.rows.map((row) => (
            <Row key={row.id} off={row.off}>
              <Cell at="main">
                <Cell at="title">{row.title}</Cell>
                {"asked" in row.priced ? <Cell at="aside">Price asked at purchase</Cell> : null}
                <Cell at="ident">
                  <CodeCopy code={row.itemId} address={row.buy} />
                </Cell>
              </Cell>
              <Cell at="amount">
                <span title={"since" in row.priced ? sinceIn(row.priced) : undefined}>
                  {row.price}
                </span>
              </Cell>
              <Cell at="fact">
                {row.delivery.says}
                {row.delivery.byDefault === null ? null : (
                  <>
                    {" "}
                    <a href={row.delivery.byDefault.href}>{row.delivery.byDefault.words}</a>
                  </>
                )}
                {"asked" in row.priced ? (
                  <span className={styles.narrowOnly}> · price asked at purchase</span>
                ) : null}
              </Cell>
              <Cell at="state">
                <Word word={row.state} />
              </Cell>
              <Control id={row.id} control={row.control} place={listing.place} />
              {"since" in row.priced ? (
                <RowMore summary="Price date" of={row.title}>
                  <Since priced={row.priced} />
                </RowMore>
              ) : null}
            </Row>
          ))}
        </List>
      )}
      <CutNote cut={listing.cut} />
      <div className={styles.notes}>
        <p>
          {note.says}
          <Rest rest={note.rest} />
        </p>
        {listing.rows.length === 0 ? null : (
          <p>The link icon beside a product code copies the address an agent buys the card at.</p>
        )}
      </div>
    </>
  );
}
