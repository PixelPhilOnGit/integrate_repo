/**
 * card 的 markdown 视图：解析（`core/markdown.ts`）→ React 元素。
 *
 * ⚠️ **没有一处 innerHTML**：块和行内都是 AST 节点映射成元素 ——
 * 卡片内容来自模型生成 + 用户手编（两边都不可信），树映射让 XSS 这一类
 * 在源头不存在（链接也只放行 http/https，见解析器）。
 */

import type { ReactNode } from 'react';
import { parseInline, parseMarkdown, type MdBlock, type MdInline } from '../core/markdown';
import { SeqView } from './SeqView';

export interface MarkdownViewProps {
  body: string;
  /** 点 `[[wikilink]]`：目标卡片存在就跳，不存在由这里就地提示断链 */
  onWikilink: (target: string) => void;
  /** 解析断链用：标题 → 是否存在 */
  linkExists: (target: string) => boolean;
}

export function MarkdownView({ body, onWikilink, linkExists }: MarkdownViewProps): ReactNode {
  const blocks = parseMarkdown(body);
  return (
    <div className="rd-kb-md" data-testid="kb-md">
      {blocks.map((block, i) => (
        <Block key={i} block={block} onWikilink={onWikilink} linkExists={linkExists} />
      ))}
    </div>
  );
}

function Block({
  block,
  onWikilink,
  linkExists,
}: {
  block: MdBlock;
  onWikilink: (target: string) => void;
  linkExists: (target: string) => boolean;
}): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const H = (['h1', 'h2', 'h3', 'h4'] as const)[Math.min(block.level, 4) - 1] ?? 'h4';
      return <H className="rd-kb-md-h">{inline(block.text, onWikilink, linkExists)}</H>;
    }
    case 'paragraph':
      return <p className="rd-kb-md-p">{inline(block.text, onWikilink, linkExists)}</p>;
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>{inline(item, onWikilink, linkExists)}</li>
      ));
      return block.ordered ? (
        <ol className="rd-kb-md-list">{items}</ol>
      ) : (
        <ul className="rd-kb-md-list">{items}</ul>
      );
    }
    case 'quote':
      return <blockquote className="rd-kb-md-quote">{inline(block.text, onWikilink, linkExists)}</blockquote>;
    case 'code':
      return <pre className="rd-kb-md-code">{block.text}</pre>;
    case 'seq':
      return <SeqView json={block.json} />;
    case 'hr':
      return <hr className="rd-kb-md-hr" />;
  }
}

function inline(
  text: string,
  onWikilink: (target: string) => void,
  linkExists: (target: string) => boolean
): ReactNode[] {
  return parseInline(text).map((node, i) => <Inline key={i} node={node} onWikilink={onWikilink} linkExists={linkExists} />);
}

function Inline({
  node,
  onWikilink,
  linkExists,
}: {
  node: MdInline;
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
      // v1 不显示图片字节（`![[…]]` 只渲染成带名字的角标）—— 诚实标注，
      // 真显示要加「按名字读 `_files/` 字节」的命令，记在 HANDOFF 里。
      // ⚠️ 不用 emoji（容器里没装 emoji 字体，会渲染成豆腐块 —— 全仓的图标
      // 规矩）；这里连 SVG 都省了，文字角标就够
      return (
        <span className="rd-kb-md-image" data-testid={`kb-image-${node.target}`} title={`图片：${node.target}`}>
          [图片] {node.target}
        </span>
      );
  }
}
