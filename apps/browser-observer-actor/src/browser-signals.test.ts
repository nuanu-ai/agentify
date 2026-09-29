import { describe, expect, it } from "vitest";

import { extractRawMetadata, rawTextCharacterCount } from "./browser-signals.js";

describe("browser signal extraction", () => {
  it("counts useful raw text without scripts and styles", () => {
    const html = `
      <html><head><style>.x { display:none }</style></head>
      <body><h1>Useful title</h1><script>secret text</script><p>Hello &amp; world</p></body></html>
    `;
    expect(rawTextCharacterCount(html)).toBe("Useful title Hello & world".length);
  });

  it("extracts only aggregate metadata and structured facts", () => {
    const result = extractRawMetadata(
      `
        <link rel="canonical" href="/products/widget?campaign=private">
        <link rel="alternate" hreflang="en" href="/en">
        <script type="application/ld+json">
          {"@type":"Product","offers":{"price":"10","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
        </script>
      `,
      "https://example.com/source",
    );
    expect(result).toEqual({
      canonical: "https://example.com/products/widget",
      hreflangCount: 1,
      jsonLdCount: 1,
      currencies: ["USD"],
      availability: ["instock"],
      priceCount: 1,
      hasContact: false,
      hasOpeningHours: false,
    });
  });
});

// A product page in the shape a hosted storefront theme serves it: app
// blocks in comments, inline configuration scripts, a style block, a
// noscript pixel, a template and structured data in the head.
const STOREFRONT_PRODUCT = `<!doctype html>
<html class="no-js" lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="canonical" href="https://shop.example.com/products/linen-shirt?variant=4242">
    <link rel="preconnect" href="https://cdn.shopify.com" crossorigin>
    <link rel="icon" type="image/png" href="//shop.example.com/cdn/shop/files/favicon.png?crop=center&height=32&v=1&width=32">
    <link rel="alternate" hreflang="x-default" href="https://shop.example.com/products/linen-shirt">
    <link rel="alternate" hreflang="en" href="https://shop.example.com/products/linen-shirt">
    <link rel="alternate" hreflang="de-DE" href="https://shop.example.com/de/products/linen-shirt">
    <title>
      Linen shirt
 &ndash; Example Shop</title>
    <meta name="description" content="Relaxed linen shirt &amp; matching trousers.">
    <script src="//shop.example.com/cdn/shop/t/2/assets/constants.js?v=1" defer="defer"></script>
    <script>window.shopUrl = 'https://shop.example.com'; window.routes = { cart_add_url: '/cart/add' };</script>
    <script>var Shopify = Shopify || {}; Shopify.currency = {"active":"EUR","rate":"1.0"}; Shopify.locale = "en";</script>
    <!-- BEGIN app block: shopify://apps/reviews/blocks/core/61ccd3b1 --><!-- END app block -->
    <style data-shopify>
      @font-face { font-family: Assistant; src: url("//shop.example.com/cdn/fonts/assistant.woff2") format("woff2"); }
      :root { --font-body-family: Assistant, sans-serif; }
      .product__title > h1 { margin: 0; }
    </style>
    <link href="//shop.example.com/cdn/shop/t/2/assets/base.css?v=1" rel="stylesheet" type="text/css" media="all" />
    <script type="application/ld+json">
      {"@context":"http://schema.org/","@type":"Product","name":"Linen shirt","url":"https://shop.example.com/products/linen-shirt","sku":"LS-01","offers":[{"@type":"Offer","availability":"http://schema.org/InStock","price":89.0,"priceCurrency":"EUR"},{"@type":"Offer","availability":"http://schema.org/OutOfStock","price":"89.00","priceCurrency":"EUR"}]}
    </script>
    <script type="application/ld+json">
      {"@context":"http://schema.org","@type":"Organization","name":"Example Shop","sameAs":["https://instagram.com/example"],"url":"https://shop.example.com"}
    </script>
  </head>
  <body class="gradient">
    <a class="skip-to-content-link button visually-hidden" href="#MainContent">Skip to content</a>
    <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"/></noscript>
    <div class="announcement-bar" role="region" aria-label="Announcement"><p>Free shipping over &euro;100</p></div>
    <header class="header"><nav><ul><li><a href="/collections/all">Shop&nbsp;all</a></li><li><a href="/pages/contact">Contact</a></li></ul></nav></header>
    <main id="MainContent" role="main">
      <h1>Linen shirt</h1>
      <div class="price"><span class="price-item">&euro;89,00 EUR</span></div>
      <p>Relaxed fit, 100% linen. Ships in 2&ndash;3 days. Rated 4.8 &#9733; by 120 customers.</p>
      <template id="variant-template"><div class="variant">Size: <span></span></div></template>
      <product-form><form method="post" action="/cart/add"><input type="hidden" name="id" value="4242"><button type="submit" name="add">Add to cart</button></form></product-form>
      <script type="application/json" id="product-json">{"id":4242,"title":"Linen shirt","available":true}</script>
    </main>
    <footer><p>&copy; 2026, Example Shop &lt;Powered by Shopify&gt;</p></footer>
    <script>
      <!--
      window.dataLayer = window.dataLayer || []; if (a < b && c > d) { dataLayer.push({ event: "view_item" }); }
      //-->
    </script>
  </body>
</html>
`;

// A product page in the shape a WordPress shop serves it: escaped inline
// scripts, conditional comments, block-editor comments, single-quoted
// attributes and a structured-data graph.
const WORDPRESS_PRODUCT = String.raw`<!DOCTYPE html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta name='robots' content='index, follow, max-image-preview:large' />
<title>Ceramic mug &#8211; Example Studio</title>
<link rel="canonical" href="https://example.com/product/ceramic-mug/" />
<meta property="og:title" content="Ceramic mug &#8211; Example Studio" />
<script type="application/ld+json" class="yoast-schema-graph">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","@id":"https://example.com/product/ceramic-mug/","url":"https://example.com/product/ceramic-mug/","name":"Ceramic mug"},{"@type":"Organization","name":"Example Studio","contactPoint":{"@type":"ContactPoint","telephone":"+49 30 000000","contactType":"customer service"}}]}</script>
<link rel='dns-prefetch' href='//fonts.googleapis.com' />
<link rel="alternate" type="application/rss+xml" title="Example Studio &raquo; Feed" href="https://example.com/feed/" />
<script>
window._wpemojiSettings = {"baseUrl":"https:\/\/s.w.org\/images\/core\/emoji\/15.0.3\/72x72\/","ext":".png"};
/*! This file is auto-generated */
!function(i,n){var o,s,e;function c(e){try{var t={supportTests:e,timestamp:(new Date).valueOf()};sessionStorage.setItem(o,JSON.stringify(t))}catch(e){}}}(window,document);
</script>
<style id='wp-emoji-styles-inline-css'>
	img.wp-smiley, img.emoji { display: inline !important; border: none !important; }
</style>
<link rel='stylesheet' id='woocommerce-general-css' href='https://example.com/wp-content/plugins/woocommerce/assets/css/woocommerce.css?ver=9.1.2' media='all' />
<!--[if lt IE 9]><script src="https://example.com/wp-content/themes/storefront/html5.js"></script><![endif]-->
<noscript><style>.woocommerce-product-gallery{ opacity: 1 !important; }</style></noscript>
</head>
<body class="product-template-default single single-product woocommerce">
<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group"><p>Handmade in Berlin.</p></div>
<!-- /wp:group -->
<div id="page" class="hfeed site">
<h1 class="product_title entry-title">Ceramic mug</h1>
<p class="price"><span class="woocommerce-Price-amount amount"><bdi>24,00&nbsp;<span class="woocommerce-Price-currencySymbol">&euro;</span></bdi></span></p>
<p class="stock in-stock">12 in stock</p>
<form class="cart" action="https://example.com/product/ceramic-mug/" method="post" enctype='multipart/form-data'>
<div class="quantity"><label class="screen-reader-text" for="quantity_1">Ceramic mug quantity</label><input type="number" id="quantity_1" class="input-text qty text" name="quantity" value="1" min="1" max="12" /></div>
<button type="submit" name="add-to-cart" value="77" class="single_add_to_cart_button button alt">Add to cart</button>
</form>
<script type='application/ld+json'>{"@context":"https:\/\/schema.org\/","@type":"Product","@id":"https:\/\/example.com\/product\/ceramic-mug\/#product","name":"Ceramic mug","offers":[{"@type":"Offer","price":"24.00","priceSpecification":{"price":"24.00","priceCurrency":"EUR","valueAddedTaxIncluded":"true"},"priceCurrency":"EUR","availability":"http:\/\/schema.org\/InStock"}]}</script>
</div>
<script type='text/javascript' id='wc-add-to-cart-js-extra'>
/* <![CDATA[ */
var wc_add_to_cart_params = {"ajax_url":"\/wp-admin\/admin-ajax.php","i18n_view_cart":"View cart"};
/* ]]> */
</script>
</body>
</html>
`;

// What the raw document says, before any script runs, is compared with what
// the browser renders. These pin what the observer reads from the markup that
// storefront platforms actually emit, so that how it is read can change
// without what it reports changing.
describe("raw HTML signals on storefront markup", () => {
  it("reads a hosted-storefront product page", () => {
    const html = STOREFRONT_PRODUCT;
    expect(rawTextCharacterCount(html)).toBe(261);
    expect(extractRawMetadata(html, "https://shop.example.com/products/linen-shirt")).toEqual({
      canonical: "https://shop.example.com/products/linen-shirt",
      hreflangCount: 3,
      jsonLdCount: 2,
      currencies: ["EUR"],
      availability: ["instock", "outofstock"],
      priceCount: 2,
      hasContact: false,
      hasOpeningHours: false,
    });
  });

  it("reads a WordPress shop product page", () => {
    const html = WORDPRESS_PRODUCT;
    expect(rawTextCharacterCount(html)).toBe(118);
    expect(extractRawMetadata(html, "https://example.com/product/ceramic-mug/")).toEqual({
      canonical: "https://example.com/product/ceramic-mug/",
      hreflangCount: 0,
      jsonLdCount: 2,
      currencies: ["EUR"],
      availability: ["instock"],
      priceCount: 2,
      hasContact: true,
      hasOpeningHours: false,
    });
  });

  it.each([
    {
      shape: "a comment opened inside a script runs to the next comment end",
      html: '<script>var marker = "<!--";</script><p>Visible</p><!-- trailing -->',
      text: 14,
    },
    {
      shape: "a raw-text element ends at any raw-text closer",
      html: "<script>a</style>b</script>c",
      text: 3,
    },
    {
      shape: "tag names are read without case",
      html: '<SCRIPT TYPE="text/javascript">x</SCRIPT>y',
      text: 1,
    },
    { shape: "a longer tag name is not a script", html: "<scripts>x</scripts>y", text: 3 },
    { shape: "a hyphen ends the tag name", html: "<script-x>z</script>w", text: 1 },
    { shape: "a closer with a space does not close", html: "<style>a</style >b", text: 3 },
    { shape: "a comment end is looked for after its opening", html: "<!-->x-->y", text: 1 },
    { shape: "empty and unclosed brackets stay text", html: "a <> b < c", text: 10 },
    { shape: "entities decode", html: "&amp;lt;b&amp;gt; &#x41;&#66; &nbsp;&NBSP;end", text: 10 },
    { shape: "Unicode spaces collapse", html: "a\u00a0\u2003b", text: 3 },
    { shape: "an unclosed comment stays text", html: "<p>open <!-- never closed", text: 22 },
    {
      shape: "noscript and template are not text",
      html: "<noscript><p>hidden</p></noscript><template><p>t</p></template>shown",
      text: 5,
    },
    {
      shape: "a script inside a textarea is still a script",
      html: "<textarea><script>x</textarea>y</script>z",
      text: 1,
    },
    {
      shape: "a non-ASCII letter does not fold into a tag name",
      html: "<\u017fcript>x</script>y",
      text: 3,
    },
  ])("counts raw text where $shape", ({ html, text }) => {
    expect(rawTextCharacterCount(html)).toBe(text);
  });

  it.each([
    {
      shape: "the link tag and its attributes are read without case",
      html: '<LINK REL="Canonical" HREF="/a?x=1#f">',
      expected: { canonical: "https://example.com/a" },
    },
    {
      shape: "a commented-out canonical still counts, and the first one wins",
      html: '<!-- <link rel="canonical" href="/old"> --><link rel="canonical" href="/new">',
      expected: { canonical: "https://example.com/old" },
    },
    {
      shape: "an alternate with a language counts, quoted or not",
      html: '<link rel="alternate stylesheet" hreflang="en" href="/en"><link rel=alternate hreflang=de href=/de><link rel="alternate" href="/no-lang">',
      expected: { hreflangCount: 2 },
    },
    {
      shape: "a longer tag name is not a link, and attributes may span lines",
      html: '<linkfoo rel="canonical" href="/x"><link\nrel="canonical"\nhref="/y">',
      expected: { canonical: "https://example.com/y" },
    },
    {
      shape: "an unparseable canonical is passed over",
      html: '<link rel="canonical" href="http://[bad"><link rel="canonical" href="/after-bad">',
      expected: { canonical: "https://example.com/after-bad" },
    },
    {
      shape: "a canonical without an address is passed over",
      html: '<link rel="canonical"><link rel="canonical" href="/second">',
      expected: { canonical: "https://example.com/second" },
    },
    {
      shape: "a non-ASCII letter does not fold into a link",
      html: "<lin\u212a rel=canonical href=/k><link rel=canonical href=/ascii>",
      expected: { canonical: "https://example.com/ascii" },
    },
    {
      shape: "structured data may be typed in single quotes",
      html: '<script type=\'application/ld+json\'>{"price":"1"}</script>',
      expected: { jsonLdCount: 1, priceCount: 1 },
    },
    {
      shape: "structured data may be typed without quotes",
      html: '<script type=application/ld+json>{"priceCurrency":"usd"}</script>',
      expected: { jsonLdCount: 1, currencies: ["USD"] },
    },
    {
      shape: "any attribute ending in type names structured data",
      html: '<script data-type="application/ld+json">{"availability":"https://schema.org/PreOrder"}</script>',
      expected: { jsonLdCount: 1, availability: ["preorder"] },
    },
    {
      shape: "a type with parameters is not structured data",
      html: '<script type="application/ld+json; charset=utf-8">{"price":"1"}</script>',
      expected: { jsonLdCount: 0, priceCount: 0 },
    },
    {
      shape: "the structured-data script is read without case and with spaced equals",
      html: '<SCRIPT TYPE = "APPLICATION/LD+JSON">{"telephone":"+1"}</SCRIPT>',
      expected: { jsonLdCount: 1, hasContact: true },
    },
    {
      shape: "the type may be named inside another attribute's value",
      html: '<script type="text/javascript" data-x="type=application/ld+json">{"openingHours":"Mo-Fr"}</script>',
      expected: { jsonLdCount: 1, hasOpeningHours: true },
    },
    {
      shape: "a block that is not JSON is counted but yields no facts",
      html: '<script type="application/ld+json"><!-- {"price":"1"} --></script>',
      expected: { jsonLdCount: 1, priceCount: 0 },
    },
    {
      shape: "a closer with a space does not close structured data",
      html: '<script type="application/ld+json">{"price":"1"}</script ><script type="application/ld+json">{"price":"2"}</script>',
      expected: { jsonLdCount: 1, priceCount: 0 },
    },
    {
      shape: "the type must be separated from the tag name",
      html: '<scripttype="application/ld+json">{"price":"1"}</script>',
      expected: { jsonLdCount: 0 },
    },
    {
      shape: "the type is given with an equals sign",
      html: '<script type:"application/ld+json">{"price":"1"}</script>',
      expected: { jsonLdCount: 0 },
    },
    {
      shape: "structured data runs to its script closer, past any other",
      html: '<script type="application/ld+json">{"price":"1"}</style><script type="application/ld+json">{"price":"2"}</script>',
      expected: { jsonLdCount: 1, priceCount: 0 },
    },
    {
      shape: "a non-ASCII letter does not fold into the structured-data type",
      html: '<script type="application/ld+j\u017fon">{"price":"1"}</script>',
      expected: { jsonLdCount: 0 },
    },
  ])("reads raw metadata where $shape", ({ html, expected }) => {
    expect(extractRawMetadata(html, "https://example.com/base/")).toMatchObject(expected);
  });

  it("reads at most two thousand link tags and fifty structured-data blocks", () => {
    const links = `${'<link rel="alternate" hreflang="en" href="/en">'.repeat(2_000)}<link rel="canonical" href="/late">`;
    expect(extractRawMetadata(links, "https://example.com/")).toMatchObject({
      canonical: null,
      hreflangCount: 2_000,
    });
    const blocks = '<script type="application/ld+json">{"price":"1"}</script>'.repeat(60);
    expect(extractRawMetadata(blocks, "https://example.com/")).toMatchObject({
      jsonLdCount: 50,
      priceCount: 50,
    });
  });
});

// A page's raw HTML is bounded only by the run's byte budget, and reading it
// is synchronous work no deadline can interrupt. So every shape a hostile page
// could repeat is read at each size up to that budget, in time that grows with
// the size and not with its square: a fixed allowance plus a fixed cost per
// MiB. The sizes double on the way up so that reading in quadratic time fails
// at the first size it overruns instead of running for hours at the last.
describe("raw HTML signals on hostile markup", () => {
  const MIB = 1024 * 1024;
  const BYTE_BUDGET = 8 * MIB;
  const allowanceMs = (size: number): number => 200 + (size / MIB) * 250;
  const NOTHING_READ = {
    canonical: null,
    hreflangCount: 0,
    jsonLdCount: 0,
    currencies: [],
    availability: [],
    priceCount: 0,
    hasContact: false,
    hasOpeningHours: false,
  };
  const timed = <T>(read: () => T): { value: T; ms: number } => {
    const startedAt = performance.now();
    const value = read();
    return { value, ms: performance.now() - startedAt };
  };

  it.each([
    { unit: "<!--", text: (html: string) => html.length },
    { unit: "<", text: (html: string) => html.length },
    { unit: "<a ", text: (html: string) => html.length - 1 },
    { unit: "<script>", text: () => 0 },
    { unit: "<script ", text: (html: string) => html.length - 1 },
    { unit: "<style ", text: (html: string) => html.length - 1 },
    { unit: "<noscript>", text: () => 0 },
    { unit: "<template ", text: (html: string) => html.length - 1 },
    { unit: "<link ", text: (html: string) => html.length - 1 },
    { unit: "<script type ", text: (html: string) => html.length - 1 },
    { unit: '<script type="application/ld+json">', text: () => 0 },
  ])("reads $unit repeated up to the byte budget in linear time", ({ unit, text }) => {
    for (let size = 64 * 1024; size <= BYTE_BUDGET; size *= 2) {
      readsInTime(unit.repeat(Math.floor(size / unit.length)), size, text);
    }
  });

  // One `>` at the very end closes every opener at once, so each of them
  // shares one tag as long as the page.
  it("reads script openers one bracket closes, up to the byte budget, in linear time", () => {
    for (let size = 64 * 1024; size <= BYTE_BUDGET; size *= 2) {
      readsInTime(`${"<script type ".repeat(Math.floor(size / 13) - 1)}>`, size, () => 0);
    }
  });

  const readsInTime = (html: string, size: number, text: (html: string) => number): void => {
    const count = timed(() => rawTextCharacterCount(html));
    expect(count.value).toBe(text(html));
    expect(count.ms, `raw text of ${html.length} characters`).toBeLessThan(allowanceMs(size));
    const metadata = timed(() => extractRawMetadata(html, "https://example.com/"));
    expect(metadata.value).toEqual(NOTHING_READ);
    expect(metadata.ms, `raw metadata of ${html.length} characters`).toBeLessThan(
      allowanceMs(size),
    );
  };
});
