/*
 * The document a state's frame is drawn from: the doctype that keeps it out of
 * quirks mode, its surface's language, the product's fonts and the surface's
 * stylesheet, then the state's markup. The gallery's script composes every
 * frame with it and the screens' check reads it from here, so what the check
 * measures is what the gallery shows. A tag the host would take for the
 * published file's own is written in two parts.
 */
globalThis.galleryFrameDocument = (lang, fonts, css, html) =>
  `<!${"doctype"} html><${"html"} lang="${lang}"><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<style>${fonts}</style><style>${css}</style>${html}`;
