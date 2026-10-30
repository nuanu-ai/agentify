import { Button } from "@agentify/ui";
import type { WooImportView } from "../../src/woo-views.js";
import { Frame } from "../components/frame.js";
import { Cell, Group, List, Row } from "../components/list.js";
import { ShopAgain, ShopForm } from "./shop-context.js";
import styles from "./woocommerce.module.css";

/** The shop's own number for a product, which the merchant finds it by in their shop. */
const InTheShop = ({ id }: Readonly<{ id: string }>) => (
  <Cell at="ident">
    <span className={styles.quiet}>Product {id} in your shop</span>
  </Cell>
);

const ONE_COLUMN = "minmax(0, 1fr)";
const WITH_ACTION = "minmax(0, 1fr) auto";

/**
 * Groups in the order of what the merchant does: put right, import again,
 * read, and last the products that went through, folded, since a shop of two
 * thousand would otherwise push everything to do below them.
 */
export function WooImportScreen({ view, base }: Readonly<{ view: WooImportView; base: string }>) {
  return (
    <div className={styles.page}>
      {view.rateSaved === null ? null : <p className={styles.done}>{view.rateSaved}</p>}
      <p className={styles.read}>
        {view.shop} · {`${view.read} ${view.read === 1 ? "product" : "products"} read`}
      </p>
      {view.toFix.length === 0 ? null : (
        // Agentify's findings word for word: the merchant's next move is to
        // change the named thing, and a paraphrase would be a second
        // description of a rule that has one.
        <Group
          title="To fix"
          count={view.toFix.length}
          warn
          aside="Change these in your shop, then import again."
        >
          <div className={styles.fixes}>
            <List label="To fix" columns={WITH_ACTION}>
              {view.toFix.map((one) => (
                <Row key={one.id} needsYou>
                  <Cell at="main">
                    <Cell at="title">{one.title}</Cell>
                    <InTheShop id={one.id} />
                    <Cell at="note">
                      <ul className={styles.findings}>
                        {one.says.map((said, at) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: one product's findings never reorder
                          <li key={at}>{said}</li>
                        ))}
                      </ul>
                    </Cell>
                  </Cell>
                  {one.fix === null ? null : (
                    <Cell at="action">
                      <a
                        className="button button-secondary button-compact"
                        href={`${base}${one.fix.to}`}
                      >
                        {one.fix.words}
                      </a>
                    </Cell>
                  )}
                </Row>
              ))}
            </List>
          </div>
          {view.tooLong ? (
            <p className={styles.after}>
              A length is counted without formatting, so your shop's editor shows a larger number.
            </p>
          ) : null}
        </Group>
      )}
      {view.unanswered.length === 0 ? null : (
        // Nobody read these products, so no edit in the shop helps.
        <Group
          title="No verdict"
          count={view.unanswered.length}
          aside="Agentify didn't answer, so we don't know if these were published. Import again: it won't create duplicates."
        >
          <List label="No verdict" columns={ONE_COLUMN}>
            {view.unanswered.map((one) => (
              <Row key={one.id}>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
                </Cell>
              </Row>
            ))}
          </List>
        </Group>
      )}
      {view.notAttempted.length === 0 ? null : (
        <Group
          title="Not attempted"
          count={view.notAttempted.length}
          aside="The import stopped before these. Import again."
        >
          <List label="Not attempted" columns={ONE_COLUMN}>
            {view.notAttempted.map((one) => (
              <Row key={one.id} off>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
                </Cell>
              </Row>
            ))}
          </List>
        </Group>
      )}
      {view.unsupported.length === 0 ? null : (
        <Group
          title="Not supported"
          count={view.unsupported.length}
          aside="The connector doesn't import these."
        >
          <List label="Not supported" columns={ONE_COLUMN}>
            {view.unsupported.map((one) => (
              <Row key={one.id} off>
                <Cell at="main">
                  <Cell at="title">{one.title}</Cell>
                  <InTheShop id={one.id} />
                  <Cell at="note">
                    <span className={styles.left}>{one.why}</span>
                  </Cell>
                </Cell>
              </Row>
            ))}
          </List>
        </Group>
      )}
      {view.published.length === 0 ? null : (
        // Named for what publishing did and no more: its answer says nothing
        // about selling, and a product the merchant paused stays paused, so
        // "on sale" would be a guess.
        <Group title="Published" count={view.published.length} aside="Paused products stay paused.">
          <details className={styles.fold}>
            <summary>Show the published products</summary>
            <List label="Published" columns={ONE_COLUMN}>
              {view.published.map((one) => (
                <Row key={one.id}>
                  <Cell at="main">
                    <Cell at="title">
                      <a href={`${base}/products?${new URLSearchParams({ q: one.code })}`}>
                        {one.title}
                      </a>
                    </Cell>
                    <InTheShop id={one.id} />
                  </Cell>
                </Row>
              ))}
            </List>
          </details>
        </Group>
      )}
      <div className={styles.ends}>
        <ShopAgain base={base} className="button button-secondary">
          Back to WooCommerce page
        </ShopAgain>
      </div>
    </div>
  );
}

/**
 * What the import result leads to next, drawn at the end of the page's bar:
 * Import again where something was left to it, Products where products went
 * through.
 */
function AfterImport({ view, base }: Readonly<{ view: WooImportView; base: string }>) {
  if (view.finished && view.published.length > 0) {
    return (
      <a className="button button-primary" href={`${base}/products`}>
        Go to Products
      </a>
    );
  }
  return (
    <ShopForm action="/woocommerce/import">
      {(pending) => <Button pending={pending}>Import again</Button>}
    </ShopForm>
  );
}

export function WooImportPage({
  view,
  base,
  onboarding,
}: Readonly<{ view: WooImportView; base: string; onboarding: boolean }>) {
  return (
    <Frame
      tab={onboarding ? "products" : "integrations"}
      title={onboarding ? "Products" : "WooCommerce import"}
      heading={view.finished ? "Import finished" : "Import stopped"}
      action={<AfterImport view={view} base={base} />}
    >
      <WooImportScreen view={view} base={base} />
    </Frame>
  );
}
