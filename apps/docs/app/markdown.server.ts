/**
 * The documentation's Markdown turned into HTML at build time by markdown-it,
 * with the few rules the pages rely on: a heading's anchor made from its
 * words, or taken from an explicit `{#id}`; the `::: note` container; the
 * `<<< @/examples/…` include, which reads the file a test validates; a
 * root-relative link mounted under `/docs` and an outside link opened apart;
 * code highlighted by Shiki; a `mermaid` fence drawn into an inline SVG from
 * its kept drawing; a site value named as `{{origin}}`; and a part kept off a
 * channel inside `:::: unless identity-confirmed` (`site-values.ts`). What the
 * build itself knows, the SDK's release, is written into the source first
 * (`build-values.ts`).
 * `WRITING.md` tells a writer which syntax this understands.
 *
 * Every page is rendered once per build: the pages and the search index read
 * the same results.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import markdownIt, {
  type MarkdownIt,
  type StateBlock,
  type StateCore,
  type Token,
} from "markdown-it";
import container from "markdown-it-container";
import { createHighlighter, type Highlighter } from "shiki";
import { withBuildValues } from "./build-values.js";
import { drawingOf } from "./diagrams.server.js";
import { includedFile, includeOf } from "./includes.js";
import { PAGES, type Page } from "./pages.js";
import { isSiteValueName, UNLESS_END, unlessTemplate, valueTemplate } from "./site-values.js";
import { APP } from "./where.server.js";

const MOUNT = "/docs";
/** GitHub's light colours made dark enough for small code to keep 4.5:1 on the page. */
const THEME = "github-light-high-contrast";

type Heading = Readonly<{ level: number; id: string; title: string }>;

export type RenderedPage = Readonly<{
  path: string;
  title: string;
  html: string;
  headings: readonly Heading[];
}>;

type Env = { headings: Heading[] };

/**
 * A heading's anchor made from its words. Links from the pages, the scanner's
 * header and the dashboard point at anchors made this way, so a change here
 * moves their targets.
 */
const slugify = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the slug drops control characters
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();

const EXPLICIT_ID = /\s*\{#([\w-]+)\}\s*$/;

/** A heading's own `{#id}`, taken off its text. */
function takeExplicitId(inline: Token): string | undefined {
  const last = inline.children?.at(-1);
  const found = last?.type === "text" ? EXPLICIT_ID.exec(last.content) : null;
  if (last === undefined || found === null) return undefined;
  last.content = last.content.slice(0, found.index);
  inline.content = inline.content.replace(EXPLICIT_ID, "");
  return found[1];
}

function headingAnchors(md: MarkdownIt): void {
  md.core.ruler.push("heading_anchors", (state: StateCore) => {
    const env = state.env as Env;
    const used = new Set<string>();
    state.tokens.forEach((open, index) => {
      const inline = state.tokens[index + 1];
      if (open.type !== "heading_open" || inline?.children == null) return;
      const explicit = takeExplicitId(inline);
      const title = inline.children
        .filter((child) => child.type === "text" || child.type === "code_inline")
        .map((child) => child.content)
        .join("");
      let id = explicit ?? slugify(title);
      for (let count = 1, base = id; explicit === undefined && used.has(id); count += 1) {
        id = `${base}-${count}`;
      }
      used.add(id);
      open.attrSet("id", id);
      open.attrSet("tabindex", "-1");
      env.headings.push({ level: Number(open.tag.slice(1)), id, title });
      // The page's own title is linked to by the page's address.
      if (open.tag === "h1") return;
      const anchor = new state.Token("html_inline", "", 0);
      anchor.content = ` <a class="header-anchor" href="#${id}" aria-label="Permalink to &quot;${md.utils.escapeHtml(inline.content)}&quot;">&ZeroWidthSpace;</a>`;
      inline.children.push(anchor);
    });
  });
}

/** `<<< @/examples/card/x.json`: the file itself, as a code block in its own language. */
function includes(md: MarkdownIt): void {
  md.block.ruler.before(
    "fence",
    "include",
    (state: StateBlock, start: number, _end: number, silent: boolean) => {
      const from = (state.bMarks[start] ?? 0) + (state.tShift[start] ?? 0);
      const named = includeOf(state.src.slice(from, state.eMarks[start]));
      if (named === undefined || (state.sCount[start] ?? 0) - state.blkIndent >= 4) return false;
      if (silent) return true;
      const file = includedFile(named);
      const token = state.push("fence", "code", 0);
      token.info = extname(file).slice(1);
      token.content = readFileSync(file, "utf8");
      token.markup = "```";
      token.map = [start, start + 1];
      state.line = start + 1;
      return true;
    },
  );
}

/**
 * A page's box, `::: note` with an optional title, drawn as the editorial
 * notice, and the part kept off a channel.
 */
function containers(md: MarkdownIt): void {
  md.use(container, "note", {
    render(tokens: Token[], index: number) {
      const token = tokens[index];
      if (token?.nesting !== 1) return "</div>\n";
      const title = token.info.trim().slice("note".length).trim();
      const heading = title ? `<p class="custom-block-title">${md.renderInline(title)}</p>` : "";
      return `<div class="editorial-notice custom-block note">${heading}\n`;
    },
  });
  md.use(container, "unless", {
    validate: (params: string) => /^unless\s+\S+$/.test(params.trim()),
    render(tokens: Token[], index: number) {
      const token = tokens[index];
      if (token?.nesting !== 1) return `${UNLESS_END}\n`;
      const name = token.info.trim().slice("unless".length).trim();
      if (!isSiteValueName(name)) throw new Error(`"unless ${name}" names no site value`);
      return `${unlessTemplate(name)}\n`;
    },
  });
}

/** A link inside the documentation is mounted under its prefix; a link off the site opens apart. */
function links(md: MarkdownIt): void {
  md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
    const token = tokens[index];
    const href = String(token?.attrGet("href") ?? "");
    if (token !== undefined && /^https?:|^\/\//i.test(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noreferrer");
    } else if (token !== undefined && href.startsWith("/")) {
      token.attrSet("href", `${MOUNT}${href}`);
    }
    return self.renderToken(tokens, index, options);
  };
  md.renderer.rules.table_open = () => '<table tabindex="0">\n';
}

function fences(md: MarkdownIt, highlighter: Highlighter): void {
  const known = new Set(highlighter.getLoadedLanguages());
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    if (token === undefined) return "";
    const lang = token.info.trim().split(/\s+/)[0] ?? "";
    if (lang === "mermaid") {
      const drawing = drawingOf(token.content);
      // The drawing's own width, which the stylesheet keeps a narrow screen
      // from shrinking it far below. The figure then scrolls sideways, so it
      // takes focus like a table does: a keyboard has to be able to scroll it.
      const width = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/.exec(drawing)?.[1];
      const style = width === undefined ? "" : ` style="--diagram-width: ${width}px"`;
      return `<figure class="diagram" tabindex="0"${style}>${drawing}</figure>\n`;
    }
    // The theme's background is dropped: the block's frame is the page's.
    const code = highlighter
      .codeToHtml(token.content.replace(/\n$/, ""), {
        lang: known.has(lang) ? lang : "text",
        theme: THEME,
      })
      .replace(/background-color:#[0-9a-f]+;?/i, "");
    return `<div class="language-${lang || "text"}"><button type="button" title="Copy Code" aria-label="Copy the code" class="copy"></button><span class="lang">${lang}</span>${code}<span class="copy-status sr-only" role="status"></span></div>\n`;
  };
}

/** The parser with every rule but the drawing of code, which needs no highlighter to parse. */
export function parser(): MarkdownIt {
  const md = markdownIt({ html: true, linkify: true });
  md.linkify.set({ fuzzyLink: false });
  md.use(includes).use(containers).use(links).use(headingAnchors);
  return md;
}

/** A value a writer names; a template the pipeline already wrote opens with `<!--`. */
const SITE_VALUE = /(?<!<!--)\{\{([a-z-]+)\}\}|%7B%7B([a-z-]+)%7D%7D/g;

/**
 * Every `{{name}}` a page writes outside its code blocks as the template
 * Caddy fills, in text, in inline code and in a link's address, where the
 * parser has written it `%7B%7Bname%7D%7D`. A name the documentation does not
 * know fails the build rather than reaching a reader.
 */
export function withSiteValues(html: string): string {
  return html
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((part) =>
      part.startsWith("<pre")
        ? part
        : part.replace(SITE_VALUE, (_whole, written?: string, encoded?: string) => {
            const name = written ?? encoded ?? "";
            if (!isSiteValueName(name)) throw new Error(`{{${name}}} names no site value`);
            return valueTemplate(name);
          }),
    )
    .join("");
}

async function renderer(): Promise<MarkdownIt> {
  const highlighter = await createHighlighter({
    themes: [THEME],
    langs: ["ts", "js", "json", "sh"],
  });
  const md = parser();
  fences(md, highlighter);
  return md;
}

/** A page's Markdown as the build reads it, with what the build knows written in. */
export const sourceOf = async (page: Pick<Page, "file">): Promise<string> =>
  withBuildValues(await readFile(join(APP, page.file), "utf8"));

async function renderAll(): Promise<ReadonlyMap<string, RenderedPage>> {
  const md = await renderer();
  const sources = await Promise.all(PAGES.map(sourceOf));
  return new Map(
    PAGES.map((page, index) => {
      const env: Env = { headings: [] };
      const html = withSiteValues(md.render(sources[index] ?? "", env));
      const title = env.headings.find((heading) => heading.level === 1)?.title ?? page.label;
      return [page.path, { path: page.path, title, html, headings: env.headings }];
    }),
  );
}

let rendered: Promise<ReadonlyMap<string, RenderedPage>> | undefined;

/** Every page, rendered on the first call of a build and kept for the rest of it. */
export function renderedPages(): Promise<ReadonlyMap<string, RenderedPage>> {
  rendered ??= renderAll();
  return rendered;
}

/** Every `mermaid` fence the pages write, as the parser reads it: what each drawing is kept for. */
export async function diagramSources(): Promise<readonly string[]> {
  const md = parser();
  const sources = await Promise.all(PAGES.map(sourceOf));
  return sources.flatMap((source) =>
    md
      .parse(source, { headings: [] } satisfies Env)
      .filter((token) => token.type === "fence" && token.info.trim() === "mermaid")
      .map((token) => token.content),
  );
}
