/**
 * 卡片里的 `seq` 围栏：**只读**渲染一张顺序图。
 *
 * # 为什么可以直接复用顺序图模块的渲染栈（跨模块 import）
 *
 * 那四件套（`parseDoc` / `computeLayout` / `<Diagram>` / `themeToCss`）是
 * 刻意做成「纯展示、不 import store」的（`Diagram.tsx` 头注释原话），
 * 所以知识库拿它们只读地画一张图，连顺序图模块的一行都不用改。
 *
 * ⚠️ 这是全仓**唯一**一处跨模块 import —— 想彻底解耦就把渲染栈搬进
 * `shared/`，那是单独一轮的事（HANDOFF 记了）。在此之前，改动顺序图的
 * 渲染层请留意这里的调用面。
 *
 * # 失败的画法
 *
 * 解析不了（脏 JSON、空图）**不白屏**：给一句人话 + 原文折叠展示 ——
 * 「不静默」是这个仓库对坏输入的一贯姿态。
 */

import { useMemo, type ReactNode } from 'react';
import { computeLayout } from '../../diagram/core/layout';
import { parseDoc } from '../../diagram/core/schema';
import { themeToCss } from '../../diagram/core/theme';
import { Diagram } from '../../diagram/render/Diagram';
import { createCanvasMeasurer } from '../../../shared/text';

// 量字是纯计算，进程里一个共享实例就够（和 useLayout.ts 同一个做法）
const measurer = createCanvasMeasurer();

export function SeqView({ json }: { json: string }): ReactNode {
  const built = useMemo(() => {
    try {
      const doc = parseDoc(json, '时序图');
      if (doc.participants.length === 0) {
        return { ok: false as const, reason: '这张图里没有参与者' };
      }
      const layout = computeLayout(doc, measurer);
      return { ok: true as const, doc, layout };
    } catch (e) {
      return {
        ok: false as const,
        reason: e instanceof Error ? e.message : '这段时序图没解析成',
      };
    }
  }, [json]);

  if (!built.ok) {
    return (
      <div className="rd-kb-seq-broken" data-testid="kb-seq-broken">
        <p className="rd-muted">（{built.reason} —— 原文：）</p>
        <pre className="rd-kb-seq-raw">{json}</pre>
      </div>
    );
  }

  const { doc, layout } = built;
  const b = layout.bounds;
  const pad = 8;
  return (
    <div className="rd-kb-seq" data-testid="kb-seq">
      <svg
        viewBox={`${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`}
        role="img"
        aria-label={doc.title}
      >
        {/* 图的配色变量跟着文档自己的主题走（和顺序图模块一致） */}
        <style>{themeToCss(doc.theme)}</style>
        <Diagram layout={layout} selection={{ type: 'none' }} pending={null} />
      </svg>
    </div>
  );
}
