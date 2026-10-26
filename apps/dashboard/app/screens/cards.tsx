import { Button } from "@agentify/ui";
import type { CardControl, CardsView } from "../../src/views.js";
import { CodeCopy } from "../components/copy.js";
import { Cell, List, ListEmpty, Row } from "../components/list.js";
import { CutNote, KeptPlace, ListTools, NothingHere } from "../components/listing.js";
import { PostForm } from "../components/post-form.js";
import { Rest } from "../components/rest.js";
import { Word } from "../components/word.js";
import styles from "./cards.module.css";

type Place = CardsView["listing"]["place"];

const Control = ({
  id,
  control,
  place,
  base,
}: Readonly<{ id: string; control: CardControl; place: Place; base: string }>) => {
  if (control.kind === "reason") {
    return (
      <Cell at="note">
        <a href={`${base}${control.to}`}>{control.text}</a>
      </Cell>
    );
  }
  return (
    <Cell at="action">
      <PostForm
        className="inline"
        action={`/products?${new URLSearchParams({ [control.verb]: id })}`}
      >
        {(pending) => (
          <>
            <KeptPlace place={place} />
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
  if (empty !== null) {
    return (
      <ListEmpty>
        <p>{empty.says}</p>
        <div className={styles.ways}>
          <a className="button button-primary" href="/docs/quickstart">
            Publish a card through the SDK
          </a>
          {empty.ways.woo ? (
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
          columns={`minmax(12rem, 1fr) 7rem 12rem 8.5rem ${reasoned ? "minmax(6.5rem, 12rem)" : "6.5rem"}`}
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
              <Control id={row.id} control={row.control} place={listing.place} base={base} />
            </Row>
          ))}
        </List>
      )}
      <CutNote cut={listing.cut} />
      <p className={styles.note}>
        {note.says}
        <Rest rest={note.rest} />
      </p>
    </>
  );
}
