import { Fragment, type ReactNode } from "react";

import type {
  EditorialBlock,
  PublicEditorialPageModel,
  RichText,
} from "../content/public-editorial";
import { EditorialPage, Notice, ProseList } from "./editorial-page";

function renderNode(
  node: Exclude<RichText, string>[number],
  key: string,
): ReactNode {
  switch (node.kind) {
    case "code":
      return <code key={key}>{node.value}</code>;
    case "strong":
      return <strong key={key}>{node.value}</strong>;
    case "link":
      return (
        <a href={node.href} key={key}>
          {node.value}
        </a>
      );
    case "text":
      return <Fragment key={key}>{node.value}</Fragment>;
  }
}

function renderRichText(content: RichText): ReactNode {
  if (typeof content === "string") return content;
  return content.map((node, index) =>
    renderNode(node, `${node.kind}-${index}`),
  );
}

function renderBlock(block: EditorialBlock, index: number): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p key={index}>{renderRichText(block.content)}</p>;
    case "notice":
      return (
        <Notice key={index}>
          <p>{renderRichText(block.content)}</p>
        </Notice>
      );
    case "list":
      return (
        <ProseList key={index}>
          {block.items.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is editorial content fixed at build time, so an item's position is its identity
            <li key={itemIndex}>{renderRichText(item)}</li>
          ))}
        </ProseList>
      );
  }
}

export function PublicEditorialPage({
  page,
}: Readonly<{ page: PublicEditorialPageModel }>) {
  return (
    <EditorialPage
      eyebrow={page.eyebrow}
      intro={page.intro}
      sections={page.sections.map((section) => ({
        id: section.id,
        title: section.title,
        content: section.blocks.map(renderBlock),
      }))}
      structuredData
      title={page.title}
    />
  );
}
