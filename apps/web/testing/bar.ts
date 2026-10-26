/**
 * The site's bar in a page's markup: how many of them the page draws, its row
 * without the narrow window's menu, which repeats some of the row's links, and
 * the words of the links the row marks as the part of the site the page is in.
 */
export function barIn(html: string) {
  const bars = html.match(/<header class="site-header[^"]*">[\s\S]*?<\/header>/g) ?? [];
  const bar = bars[0] ?? "";
  const row = bar.slice(0, bar.indexOf('<details class="site-menu"'));
  return {
    count: bars.length,
    row,
    marked: [...row.matchAll(/<a\b[^>]*aria-current="true"[^>]*>([^<]*)<\/a>/g)].map(
      ([, words]) => words,
    ),
    /** Whether the row offers the way past it, the lockup home, the site's offers and both doors. */
    whole:
      row.includes('href="#main"') &&
      ["/", "/agentic-shop", "/docs/", "/dashboard/sign-in"].every((href) =>
        row.includes(`href="${href}"`),
      ) &&
      html.includes('id="main"'),
  };
}
