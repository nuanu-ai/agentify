declare module "markdown-it-container" {
  import type { MarkdownIt, Token } from "markdown-it";

  type Options = Readonly<{
    validate?: (params: string, markup: string) => boolean;
    render?: (tokens: Token[], index: number) => string;
    marker?: string;
  }>;

  const container: (md: MarkdownIt, name: string, options?: Options) => void;
  export default container;
}
