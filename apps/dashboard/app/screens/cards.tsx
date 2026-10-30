import { Button } from "@agentify/ui";
import type { CardsView } from "../../src/views.js";
import { CodeCopy } from "../components/copy.js";
import { Cell, List, ListEmpty, Row } from "../components/list.js";
import { PostForm } from "../components/post-form.js";
import { Rest } from "../components/rest.js";
import { Word } from "../components/word.js";
import styles from "./cards.module.css";
import { CutNote, KeptPlace, ListTools, NothingHere } from "./listing.js";

type Place = CardsView["listing"]["place"];

const Switch = ({
  id,
  verb,
  place,
}: Readonly<{ id: string; verb: "pause" | "resume"; place: Place }>) => (
  <Cell at="action">
    <PostForm className="inline" action={`/products?${new URLSearchParams({ [verb]: id })}`}>
      {(pending) => (
        <>
          <KeptPlace place={place} />
          <Button compact variant={verb === "resume" ? "primary" : "secondary"} pending={pending}>
            {verb === "resume" ? "Resume" : "Pause"}
          </Button>
        </>
      )}
    </PostForm>
  </Cell>
);

/** The control that stops or restarts all selling, for the end of the page's title bar. */
export function AllSelling({ view }: Readonly<{ view: CardsView }>) {
  const { allSelling, listing } = view;
  return (
    <PostForm className="inline" action={`/products?selling=${allSelling.verb}`}>
      {(pending) => (
        <>
          <KeptPlace place={listing.place} />
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
  const elsewhere =
    view.elsewhere === null ? null : <p className={styles.elsewhere}>{view.elsewhere}</p>;
  if (empty !== null) {
    return (
      <>
        <ListEmpty>
          <p>{empty.says}</p>
          <div className={styles.ways}>
            {empty.ways.sdk ? (
              <a className="button button-primary" href="/docs/quickstart">
                Publish products through the SDK
              </a>
            ) : null}
            {empty.ways.woo === null ? null : (
              <a
                className={`button ${empty.ways.sdk ? "button-secondary" : "button-primary"}`}
                href={`${base}/woocommerce`}
              >
                {empty.ways.woo}
              </a>
            )}
          </div>
        </ListEmpty>
        {elsewhere}
      </>
    );
  }
  return (
    <>
      <ListTools
        listing={listing}
        path="/products"
        label="Search products"
        placeholder="Search by name or product code"
      />
      {view.byCode === null || listing.rows.length === 0 ? null : (
        <p className={styles.byCode}>{view.byCode}</p>
      )}
      {listing.rows.length === 0 ? (
        <NothingHere listing={listing} />
      ) : (
        <List
          label="Products"
          columns="minmax(12rem, 1fr) 7rem 12rem 8.5rem 6.5rem"
          head={["Product", { text: "Price", end: true }, "Delivery", "State", ""]}
        >
          {listing.rows.map((row) => (
            <Row key={row.id} off={row.off}>
              <Cell at="main">
                <Cell at="title">{row.title}</Cell>
                {row.priceAsked ? <Cell at="aside">Price asked at purchase</Cell> : null}
                <Cell at="ident">
                  <CodeCopy code={row.itemId} address={row.buy} />
                </Cell>
              </Cell>
              <Cell at="amount">{row.price}</Cell>
              <Cell at="fact">
                {row.delivery.says}
                {row.delivery.byDefault === null ? null : (
                  <>
                    {" "}
                    <a href={row.delivery.byDefault.href}>{row.delivery.byDefault.words}</a>
                  </>
                )}
                {row.priceAsked ? (
                  <span className={styles.narrowOnly}> · price asked at purchase</span>
                ) : null}
              </Cell>
              <Cell at="state">
                <Word word={row.state} />
              </Cell>
              <Switch id={row.id} verb={row.verb} place={listing.place} />
            </Row>
          ))}
        </List>
      )}
      <CutNote cut={listing.cut} />
      {elsewhere}
      <p className={styles.note}>
        {note.says}
        <Rest rest={note.rest} />
      </p>
    </>
  );
}
