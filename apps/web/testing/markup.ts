import { createRequire } from "node:module";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document } };
};

/** A server-rendered document, read without running its scripts. */
export const documentOf = (html: string): Document => new JSDOM(html).window.document;
