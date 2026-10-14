/**
 * The search's fields and ranking, the ones VitePress's local search uses, so
 * the same query over the same sections ranks them the same way. The index
 * is built with these at build time and loaded with them in the browser. A
 * section's text is kept in the index as well as searched, so a result can
 * show the words it was found by.
 */

export const SEARCH_OPTIONS = {
  fields: ["title", "titles", "text"],
  storeFields: ["title", "titles", "text"],
  searchOptions: { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 2, titles: 1 } },
};

/** One section of a page as the search keeps it: its address, the headings above it and its text. */
export type SearchHit = Readonly<{
  id: string;
  title: string;
  titles: readonly string[];
  text: string;
  terms: readonly string[];
}>;
