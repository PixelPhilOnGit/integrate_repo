/**
 * card 的 markdown 视图：解析（`core/markdown.ts`）→ React 元素。
 *
 * ⚠️ **没有一处 innerHTML**：块和行内都是 AST 节点映射成元素 ——
 * 卡片内容来自模型生成 + 用户手编（两边都不可信），树映射让 XSS 这一类
 * 在源头不存在（链接也只放行 http/https，见解析器）。
 */

import type { ReactNode } from 'react';
import { ImageEmbed } from '../../../shared/media/ImageEmbed';
import { parseInline, parseMarkdown, type MdBlock, type MdInline } from '../core/markdown';
import { SeqView } from '../../../shared/diagram/SeqView';

export interface MarkdownViewProps {
  body: string;
  /** 读图片字节（`![[…]]` 内嵌显示用）；不传时回落文字角标 */
  loadImage?: (target: string) => Promise<ArrayBuffer>;
  /** 点 `[[wikilink]]`：目标卡片存在就跳，不存在由这里就地提示断链 */
  onWikilink: (target: string) => void;
  /** 解析断链用：标题 → 是否存在 */
  linkExists: (target: string) => boolean;
}

export function MarkdownView({
  body,
  loadImage,
  onWikilink,
  linkExists,
}: MarkdownViewProps): ReactNode {
  const blocks = parseMarkdown(body);
  return (
    <div className="rd-kb-md" data-testid="kb-md">
      {blocks.map((block, i) => (
        <Block
          key={i}
          block={block}
          loadImage={loadImage}
          onWikilink={onWikilink}
          linkExists={linkExists}
        />
      ))}
    </div>
  );
}

function Block({
  block,
  loadImage,
  onWikilink,
  linkExists,
}: {
  block: MdBlock;
  loadImage?: (target: string) => Promise<ArrayBuffer>;
  onWikilink: (target: string) => void;
  linkExists: (target: string) => boolean;
}): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const H = (['h1', 'h2', 'h3', 'h4'] as const)[Math.min(block.level, 4) - 1] ?? 'h4';
      return <H className="rd-kb-md-h">{inline(block.text, loadImage, onWikilink, linkExists)}</H>;
    }
    case 'paragraph':
      return <p className="rd-kb-md-p">{inline(block.text, loadImage, onWikilink, linkExists)}</p>;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>{inline(item, loadImage, onWikilink, linkExists)}</li>
      ));
      return block.ordered ? (
        <ol className="rd-kb-md-list">{items}</ol>
      ) : (
        <ul className="rd-kb-md-list">{items}</ul>
      );
    }
    case 'quote':
      return <blockquote className="rd-kb-md-quote">{inline(block.text, loadImage, onWikilink, linkExists)}</blockquote>;
    case 'code':
      return <pre className="rd-kb-md-code">{block.text}</pre>;
    case 'seq':
      return <SeqView json={block.json} testId="kb-seq" brokenTestId="kb-seq-broken" />;
    case 'hr':
      return <hr className="rd-kb-md-hr" />;
  }
}

function inline(
  text: string,
  loadImage: ((target: string) => Promise<ArrayBuffer>) | undefined,
  onWikilink: (target: string) => void,
  linkExists: (target: string) => boolean
): ReactNode[] {
  return parseInline(text).map((node, i) => (
    <Inline
      key={i}
      node={node}
      loadImage={loadImage}
      onWikilink={onWikilink}
      linkExists={linkExists}
    />
  ));
}

function Inline({
  node,
  loadImage,
  onWikilink,
  linkExists,
}: {
  node: MdInline;
  loadImage?: (target: string) => Promise<ArrayBuffer>;
  onWikilink: (target: string) => void;
  linkExists: (target: string) => boolean;
}): ReactNode {
  switch (node.kind) {
    case 'text':
      return node.text;
    case 'bold':
      return <strong>{node.text}</strong>;
    case 'italic':
      return <em>{node.text}</em>;
    case 'code':
      return <code className="rd-mono rd-kb-md-icode">{node.text}</code>;
    case 'link':
      // 外链交给系统浏览器（平台层还没暴露 openUrl……v1 就渲染成可复制的样式，
      // 不假装能点 —— 「点了没反应」比「看起来不能点」坏得多）
      return (
        <span className="rd-kb-md-link" title={node.url}>
          {node.text}
        </span>
      );
    case 'wikilink': {
      const exists = linkExists(node.target);
      return (
        <button
          type="button"
          className={`rd-kb-md-wiki${exists ? '' : ' is-broken'}`}
          data-testid={`kb-wiki-${node.target}`}
          title={exists ? `跳转到「${node.target}」` : `「${node.target}」还不存在（断链）`}
          onClick={() => onWikilink(node.target)}
        >
          {node.alias}
        </button>
      );
    }
    case 'image':
      // 有加载器就内嵌显示（点击放大）；加载失败由 `ImageEmbed` 回落成
      // 现在的文字角标 —— 图片坏了不该让整个阅读器炸掉。
      if (loadImage !== undefined) {
        return (
          <ImageEmbed
            target={node.target}
            load={loadImage}
            testId={`kb-image-${node.target}`}
            lightboxTestId="kb-image-lightbox"
          />
        );
      }
      return (
        <span className="rd-kb-md-image" data-testid={`kb-image-${node.target}`} title={`图片：${node.target}`}>
          [图片] {node.target}
        </span>
      );
  }
}
