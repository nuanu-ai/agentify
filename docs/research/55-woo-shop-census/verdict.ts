/**
 * The census note's verdict on each WooCommerce shop, and the counts the note
 * reports, from a file the census's extraction wrote: every shop under an
 * opaque id, its access classes, and the product pages its public Store API
 * listing returned. No shop's address is read or written here.
 *
 *   node --import ./resolve-ts.mjs verdict.ts <shops.json>
 *
 * The products are judged by the connector's own `cardsFromTheShop`, with the
 * three fields the public listing lacks set to the values that let a parcel
 * through; what the listing shows is then checked as the note's steps say.
 */
import { readFileSync } from "node:fs";
import {
  cardsFromTheShop,
  type StoreProduct,
  StoreProductsSchema,
} from "../../../apps/dashboard/src/woo-catalog.ts";

interface Shop {
  readonly id: string;
  readonly group: "ID" | "US" | "EU";
  readonly region: string | null;
  readonly country: string | null;
  readonly robotsDisallowsListing: boolean;
  readonly frontClass: string | null;
  readonly honestClass: string | null;
  readonly connectorClass: string | null;
  readonly probeWhat: string | null;
  readonly probeClass: string | null;
  readonly probeProducts: readonly unknown[];
  readonly total: number | null;
  readonly pages: readonly (readonly unknown[])[];
  readonly unreadPages: boolean;
  readonly shopOrigin: string;
  readonly priceSuffixes: readonly string[];
}

type Raw = Record<string, unknown>;

const REASONS = [
  "currency",
  "decimals",
  "over 200 products",
  "plain permalinks or a sub-path",
  "listing closed by the shop",
  "not simple",
  "managed stock (inferred)",
  "sold individually",
  "out of stock or on backorder",
  "not purchasable",
  "empty description",
  "price suffix (tax)",
] as const;
type Reason = (typeof REASONS)[number];

const BLOCKED = new Set(["Challenged", "Rate-limited", "Refused by a firewall"]);

const listedProducts = (shop: Shop): Raw[] => shop.pages.flat() as Raw[];

/** The fields a public listing does not carry, set so that a parcel passes. */
const asParcel = (product: Raw): Raw => ({
  ...product,
  virtual: false,
  downloadable: false,
  manage_stock: false,
});

const managedByInference = (product: Raw): boolean => {
  if (product.is_in_stock !== true || product.is_on_backorder === true) return false;
  const availability = (product.stock_availability ?? {}) as { text?: string };
  return (
    (product.low_stock_remaining !== null && product.low_stock_remaining !== undefined) ||
    (availability.text ?? "") !== ""
  );
};

const hasSuffix = (product: Raw): boolean =>
  String(product.price_html ?? "").includes("woocommerce-price-suffix");

/** A copy of the product with one product-level reason taken as passed. */
const lifting = (product: Raw, lifted: ReadonlySet<Reason>): Raw => {
  let p: Raw = { ...product };
  const prices = { ...((p.prices ?? {}) as Raw) };
  if (lifted.has("currency") && prices.currency_code !== "USD") {
    prices.currency_code = "USD";
    prices.currency_minor_unit = 2;
  }
  if (lifted.has("decimals")) prices.currency_minor_unit = 2;
  p.prices = prices;
  if (lifted.has("not simple")) p = { ...p, type: "simple" };
  if (lifted.has("not purchasable")) p = { ...p, is_purchasable: true };
  if (lifted.has("out of stock or on backorder"))
    p = { ...p, is_in_stock: true, is_on_backorder: false };
  if (lifted.has("sold individually")) p = { ...p, sold_individually: false };
  if (lifted.has("empty description")) p = { ...p, description: "A description." };
  return p;
};

interface Judged {
  readonly qualifying: number;
  readonly withoutManagedCheck: number;
  readonly qualifyingDescriptionsFit: number;
}

const judgeProducts = (shop: Shop, raw: readonly Raw[], lifted: ReadonlySet<Reason>): Judged => {
  const docs = raw.map((p) => asParcel(lifting(p, lifted)));
  const parsed = StoreProductsSchema.safeParse(docs);
  if (!parsed.success)
    return { qualifying: 0, withoutManagedCheck: 0, qualifyingDescriptionsFit: 0 };
  const { cards } = cardsFromTheShop(parsed.data as StoreProduct[], shop.shopOrigin);
  const byId = new Map(docs.map((d) => [String(d.id), d]));
  let qualifying = 0;
  let withoutManagedCheck = 0;
  let fit = 0;
  for (const card of cards) {
    const doc = byId.get(card.id) as Raw;
    if (doc.sold_individually === true || doc.is_on_backorder === true) continue;
    withoutManagedCheck += 1;
    if (!lifted.has("managed stock (inferred)") && managedByInference(doc)) continue;
    qualifying += 1;
    if (card.card.description.length <= 500) fit += 1;
  }
  return { qualifying, withoutManagedCheck, qualifyingDescriptionsFit: fit };
};

interface Verdict {
  readonly verdict: string;
  readonly reasons: readonly string[];
  readonly descriptionsFit?: boolean;
}

const verdictOf = (shop: Shop, lifted: ReadonlySet<Reason> = new Set()): Verdict => {
  if (shop.robotsDisallowsListing)
    return { verdict: "unknown (robots.txt)", reasons: ["robots.txt"] };
  const honest = shop.honestClass ?? "Unreachable";
  if (BLOCKED.has(honest)) return { verdict: "unknown (blocked)", reasons: [honest] };
  if (honest === "Unreachable") return { verdict: "unknown (unreachable)", reasons: [honest] };

  const reasons: string[] = [];
  let products = listedProducts(shop);
  let partial = false;
  if (honest !== "Readable") {
    const atProbe = shop.probeClass === "Readable" || shop.probeClass === "Empty";
    if (atProbe) {
      reasons.push(shop.probeWhat === "probe-subpath" ? "a sub-path" : "plain permalinks");
      if (!lifted.has("plain permalinks or a sub-path")) return { verdict: "cannot", reasons };
      products = shop.probeProducts as Raw[];
      partial = true;
    } else {
      reasons.push(
        honest === "Closed by the shop" ? "listing closed by the shop" : `listing ${honest}`,
      );
      return { verdict: "cannot", reasons };
    }
  }
  const lastPage = shop.pages.at(-1) ?? [];
  const over200 =
    (shop.total !== null && shop.total > 200) ||
    (shop.total === null && shop.pages.length >= 3 && lastPage.length > 0);
  if (over200) {
    reasons.push("over 200 products");
    partial = true;
  }
  const currencies = new Set(
    products.map((p) => String((p.prices as Raw | undefined)?.currency_code)),
  );
  const scales = new Set(
    products.map((p) => Number((p.prices as Raw | undefined)?.currency_minor_unit)),
  );
  const notUsd = [...currencies].some((c) => c !== "USD");
  if (notUsd) reasons.push("currency");
  if (!notUsd && [...scales].some((s) => s !== 2)) reasons.push("decimals");
  const shopRefused = reasons.filter(
    (r) =>
      !(
        (r === "over 200 products" && lifted.has("over 200 products")) ||
        (r === "currency" && lifted.has("currency")) ||
        (r === "decimals" && lifted.has("decimals"))
      ),
  );
  const observedShopRefusal = shopRefused.filter(
    (r) => r !== "a sub-path" && r !== "plain permalinks",
  );
  if (observedShopRefusal.length > 0) return { verdict: "cannot", reasons };

  const countUnknown = shop.total === null && shop.unreadPages && !over200;
  if (countUnknown && !lifted.has("over 200 products")) {
    return { verdict: "unknown (incomplete)", reasons: [...reasons, "count unknown"] };
  }
  if (products.some(hasSuffix)) {
    reasons.push("price suffix (tax)");
    if (!lifted.has("price suffix (tax)"))
      return { verdict: "cannot (inferred: tax calculation)", reasons };
  }
  const judged = judgeProducts(shop, products, lifted);
  if (judged.qualifying > 0) {
    return {
      verdict: "could, conditionally",
      reasons,
      descriptionsFit: judged.qualifyingDescriptionsFit > 0,
    };
  }
  if (shop.unreadPages && !partial)
    return { verdict: "unknown (incomplete)", reasons: [...reasons, "pages unread"] };
  if (judged.withoutManagedCheck > 0) {
    return {
      verdict: "cannot (inferred: managed stock)",
      reasons: [...reasons, "managed stock (inferred)"],
    };
  }
  return { verdict: "cannot", reasons: [...reasons, "no qualifying product"] };
};

const soleBlockers = (shop: Shop, base: Verdict): Reason[] =>
  base.verdict.startsWith("cannot")
    ? REASONS.filter((r) => verdictOf(shop, new Set([r])).verdict === "could, conditionally")
    : [];

const share = (n: number, d: number): string =>
  d === 0 ? "—" : `${n}/${d} (${Math.round((100 * n) / d)}%)`;

const main = (): void => {
  const input = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as { shops: Shop[] };
  const rows = input.shops.map((shop) => {
    const v = verdictOf(shop);
    return {
      id: shop.id,
      group: shop.group,
      region: shop.region,
      country: shop.country,
      verdict: v.verdict,
      reasons: v.reasons,
      descriptionsFit: v.descriptionsFit ?? null,
      soleBlockers: soleBlockers(shop, v),
      connectorRefusedHonestAnswered:
        shop.honestClass === "Readable" &&
        shop.connectorClass !== null &&
        shop.connectorClass !== "Readable",
      honestClass: shop.honestClass,
      connectorClass: shop.connectorClass,
    };
  });
  const groups: Record<string, typeof rows> = {
    Bali: rows.filter((r) => r.group === "ID" && r.region === "Bali"),
    "Indonesia outside Bali": rows.filter((r) => r.group === "ID" && r.region !== "Bali"),
    Indonesia: rows.filter((r) => r.group === "ID"),
    "United States": rows.filter((r) => r.group === "US"),
    Europe: rows.filter((r) => r.group === "EU"),
  };
  const summary: Record<string, unknown> = {};
  for (const [name, list] of Object.entries(groups)) {
    const verdicts: Record<string, number> = {};
    const blockers: Record<string, number> = {};
    for (const r of list) {
      verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
      for (const b of r.soleBlockers) blockers[b] = (blockers[b] ?? 0) + 1;
    }
    const could = list.filter((r) => r.verdict === "could, conditionally");
    summary[name] = {
      shops: list.length,
      verdicts,
      couldConditionally: share(could.length, list.length),
      conditionalWithDescriptionThatFits: share(
        could.filter((r) => r.descriptionsFit).length,
        could.length,
      ),
      soleBlockers: Object.fromEntries(
        Object.entries(blockers).map(([k, n]) => [k, share(n, list.length)]),
      ),
      connectorRefusedWhileHonestAnswered: share(
        list.filter((r) => r.connectorRefusedHonestAnswered).length,
        list.length,
      ),
    };
  }
  process.stdout.write(`${JSON.stringify({ summary, rows }, null, 1)}\n`);
};

main();
