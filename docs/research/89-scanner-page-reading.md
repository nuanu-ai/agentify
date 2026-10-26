# How the scanner reads a page

The scanner reads the HTML of a site's home page and of one product page for
the server-rendered content check and several others. From each page it takes
the text a visitor sees, the title and the first-level heading, the links to
products, the hreflang alternates, the JSON-LD, and whether a price is stated.
This note records how that reading is built, why it does not use a parser
library, how a price is recognised, and what the reading still gets wrong. The
code is in `packages/scanner/src/`: `html.ts`, `parsers.ts` and `price.ts`.

## The defect it replaced

Each reader used to strip tags by hand. A `<` with no `>` after it kept the
rest of the page, and a comment was taken for a tag that ended at its first
`>`. The fetch reads at most 2 MiB of a page, and a store's page often carries
its state in one large inline script. A page cut inside that script therefore
gave about two million characters of visible text, and the check passed it as
substantive. The price signal was one regular expression over the raw page
that knew four symbols and five codes. It missed `USD 0.01`, `Rp 150.000` and
`5,00 €`, and it counted a `$1` inside a script.

## One tokenizer, written here

`html.ts` splits a page the way the tokenizer in the HTML standard does. It
reads attributes with their quoting, so a quoted value may hold a `>`, and
keeps the first of a repeated attribute. It decodes character references. It
ends a comment where the standard ends one, including `<!-->` and `--!>`, and
reads doctypes and bogus comments up to their `>`. The content of `script`,
`style`, `title`, `textarea` and the other raw-text elements is read raw, a
script's escaped comment states included, so an older page's
`<!-- document.write("<script>…</script>") -->` stays inside its script. An
`svg` or `math` element opens foreign content, where none of that raw reading
applies. The start tags the standard lists close it again, and so does the
end tag of an HTML element that was open around it, which is how a browser
recovers from an icon a theme left without its `</svg>`. The tokenizer
counts the open elements by name rather than keeping the parser's stack of
them, so an end tag costs the same however deep a page nests. Whatever the
page ends inside of yields nothing: a tag, a comment, or the content of a raw
element whose end tag never came. The page was cut there, and what it was
about to say is unknown.

Of tree construction it keeps only what changes how the text is split. It
leaves out implied end tags, foster parenting and the adoption agency, and it
reads SVG's `foreignObject`, `title` and `desc` as SVG, where a browser reads
HTML inside them.

The readers in `parsers.ts` take everything from one pass over the tokens.
`readPage` gives the visible text, the signals and the JSON-LD of a page
together, with one parse of its JSON-LD, so a check need not read a page
three times. Template content is inert, unless the template is a declarative
shadow root (`shadowrootmode` or the older `shadowroot`, open or closed),
which the browser attaches and shows, and which a web component rendered on
the server, as Lit renders one, writes its content into. Navigation is left
out of the visible text, and `noscript` is read as markup, since the scanner
sees a page as a reader that runs no scripts does. A heading counts when it
holds text anywhere inside it, not only right after its tag.

Character references are decoded with `entities` 8.1.0, the decoder the
workspace already pins and parse5 itself uses. It carries the standard's table
of named references and its rules for references written without a semicolon.

### Why not parse5

parse5 is the parser jsdom uses, and it follows the standard closely. It was
measured on Node 24 before anything was written here, and the measurement
decided against it. On a 2 MiB page of product cards its tokenizer took 40 to
60 ms and a full parse 60 to 95 ms, which would do. But its tokenizer checks
each new attribute against the earlier attributes of the same tag, so a tag
of distinct attributes costs time quadratic in their number: 10,000 took
0.14 s, 20,000 took 0.47 s, and 40,000, about 270 KB, took 3.7 s. A 2 MiB page
holds about 300,000. Its tree builder is quadratic in nesting depth too:
20,000 unclosed `div` elements took 1.3 s, and 2 MiB holds about 400,000. The
scan reads synchronously in a worker that other scans share, so one page
could stall the worker for minutes. The tokenizer here keeps attributes in a
map and never compares them pairwise, and it does not search the rest of
the page again for every comment.

The figures were taken on the development machine with other work running,
at a load average of about 4. The shapes matter more than the absolute times.
Reading the visible text, the signals and the JSON-LD of one 2 MiB page took
the readers here 50 to 60 ms for the page of product cards, 150 to 230 ms for
250,000 distinct attributes, 120 to 190 ms for unclosed `div` tags, and 100
to 150 ms for a page of numbers. The hand-rolled readers took 15 to 140 ms on
the same inputs and read them wrongly. The tests hold each such shape to
500 ms.

## How a price is recognised

Structured data is read first, since it says what the amount and the currency
are. That is an offer's `price`, `lowPrice` or `highPrice` at any depth of the
JSON-LD, a microdata `itemprop="price"` from its `content` or `value`
attribute or its text, and the `content` of the `product:price:amount` and
`og:price:amount` meta tags. The JSON-LD is walked once per script, as
parsed, rather than through the nodes its graphs flatten to, which would
repeat a nested graph's members once for each graph around them. Only when
none of those states an amount is the visible text read, for an amount
written next to a currency marker on either side. Scripts, comments,
template content and any other attribute are never read for a price.

The markers come from the runtime's data. `Intl.supportedValuesOf("currency")`
gives 162 ISO 4217 codes on Node 24, and each code is a marker. For each code,
`Intl.NumberFormat` is asked for the currency's symbol and narrow symbol in
English and in the language of the currency's own country. The country is
the code's first two letters, and its language comes from the likely subtags
of `Intl.Locale`; codes that begin with X belong to no country. That gives
`Rp`, `zł`, `R$`, `₫`, `₹`, `₽`, `kr`, `Kč`, `Ft`, `лв.`, `S/`, `ر.س.` and
the rest, from 634 formatters built once, for the first page whose text is
read for a price, in about 60 ms; a process that imports the scanner and
never looks for a price does not pay for them. Invisible marks some locales
write into a symbol are removed, and the Cape Verdean escudo, whose symbol in
the data is only such a mark, gets none.
A closing dot after a letter is optional in the text, so `kr.` and `kr`,
`Rs.` and `Rs` all match.

Eight markers are added by hand, because shops write them widely and the
locale data does not:

| Marker | Currency | Why |
| --- | --- | --- |
| 円 | JPY | Japanese shops write 1,980円; the data gives ￥ and ¥ |
| 元 | CNY | Chinese shops write 199元 beside ¥ |
| 원 | KRW | Korean shops write 15,000원; the data gives ₩ |
| đ | VND | Vietnamese shops write 150.000đ beside ₫ |
| TL | TRY | Turkish shops write 149,90 TL; the data gives ₺ |
| руб | RUB | Russian shops write 1 500 руб.; the data gives ₽ |
| грн | UAH | Ukrainian shops write 1 200 грн; the data gives ₴ |
| KSh | KES | Kenyan shops write KSh 1,500; the data gives Ksh |

An amount may be written in digits of any script and grouped any way: by
commas, dots or apostrophes, by a space before three digits, or by the Arabic
separators, with a dash for no cents as in `CHF 1'200.–`. Indian lakh
grouping such as `₹1,20,000` reads as well. A run of digits longer than 24
characters is not an amount, which also keeps what the evidence quotes short.

A product page's own words carry markers too, so a few rules keep them out.
An amount followed by a percent sign is a share. Some markers are also a
size, a model, an abbreviation or an English word: one Latin letter (R for
the rand, Q for the quetzal, but also Galaxy S24, an E27 bulb, an M10 bolt),
two Latin capitals (FC, KM, RM, SR), and a short list of codes and symbols
that are words or units where shops write them. The list is ALL, TOP, TRY,
CUP, PEN, MAD, GEL, SOS, BOB, MOP, CAD, BAM and ZAR, which are English words
or names; PHP, a programming language; COP, a climate conference; AWG, a
wire gauge; AMD and NAD, makers of processors and amplifiers; RON, a fuel's
octane rating; SAR, a phone's radiation rate; CRC, a checksum; Ft for feet
in a title-cased name, kn for knots, and Le, a French article. Such a marker
counts only next to an amount written the way money is, with its thousands
grouped or a decimal part of two or three digits, so `R 1 299` and
`50 000 Ft` count while `S24`, `TOP 10`, `PHP 8.2` and `FC 25` do not. One
letter counts only right before the amount, where the countries that use it
write it. Every other code and symbol takes any amount, so `AED 99`,
`kr 199` and `€ 5` count.

A marker of Latin letters next to a bare year, 19xx or 20xx, is a date or
an edition: `Sale 2024 USD`, `WORLD CUP 2026`, `© 2025 ALL RIGHTS RESERVED`.
円, 元 and 원 count only after the amount, where Japanese, Chinese and Korean
shops write them; before a number they end a word, as in `고객지원 1588` or
`公元2024`. A marker in a script with letter case does not count inside a
word, so `CARS 3` is not a price in Argentine pesos and `2 CUPS` is not one
in Cuban pesos; Japanese, Chinese and Korean attach the next word to a
marker, so for them that rule does not apply.

A price found in the text names no currency, since `$` alone belongs to
thirty currencies. Structured data names the currency it states when that is
an ISO 4217 code, and nothing otherwise. The server-rendered content check
reports what it found as `price_signal` and where as `price_signal_source`.

### What it still gets wrong

The price is a presence signal, and it errs in both directions. It still takes
a word for a price when the number beside it is written like money, such as
`TOP 1,000 BESTSELLERS`, and it takes any amount next to a code or symbol that
is not on the word list. It misses a price whose currency is spelled out (`199
kronor`, `150 rubles`) or abbreviated in a way the data and the table do not
hold (`150.000 VNĐ`, `S/. 59.90`, `Fr. 49.90`, `Dhs 50`), a code written in
lower case, a marker parted from the amount by anything other than a single
space, and a word-like marker's plain amount (`R150`, `RM 25`, `450 Ft`, `150
TL`). A price that looks like a year is missed next to a marker of Latin
letters (`1999 kr`), and so is a one-letter currency's price written after its
amount. The evidence shows the words it matched, so a wrong signal can be seen
in the report.

## Sitemaps

A sitemap is XML and is not read with this tokenizer, but its reader had the
same blind spot. It now skips comments, so a retired entry left in one is not
read as live, and it reads an address or a date written in a CDATA section,
which some generators use for every entry.
