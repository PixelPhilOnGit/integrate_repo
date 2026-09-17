/**
 * 文字测量。
 *
 * 为什么做成可注入的接口：布局计算需要知道文字宽度才能给参与者方框定尺寸，
 * 而真实测量依赖 canvas（浏览器环境）。把测量抽象成接口后：
 *   - 运行时注入基于 CanvasRenderingContext2D.measureText 的实现，与实际渲染字体严格一致
 *   - 测试里注入确定性的估算实现，布局逻辑就能在 node 下跑，无需 DOM
 *
 * 因此所有布局测试断言的是**不变量**（方框包得住文字、互不重叠、间距单调），
 * 而不是具体像素值 —— 这样测试既快又不会因为字体差异而碎掉。
 */

export interface TextMeasurer {
  /** 返回文本在给定字号下的像素宽度 */
  measure(text: string, fontSize: number, fontFamily: string): number;
}

/**
 * 浏览器实现：直接量真实渲染宽度。
 * 复用同一个离屏 canvas 上下文，避免每次调用都新建。
 */
export function createCanvasMeasurer(): TextMeasurer {
  let ctx: CanvasRenderingContext2D | null = null;
  let cachedFont = '';
  return {
    measure(text: string, fontSize: number, fontFamily: string): number {
      if (!ctx) {
        const canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d');
      }
      if (!ctx) return estimateTextWidth(text, fontSize);
      const font = `${fontSize}px ${fontFamily}`;
      if (font !== cachedFont) {
        ctx.font = font;
        cachedFont = font;
      }
      return ctx.measureText(text).width;
    },
  };
}

/** CJK 字符按全角宽度计，其余按半角估。用于没有 canvas 时的兜底与测试。 */
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    width += CJK.test(ch) ? 1.0 : 0.52;
  }
  return width * fontSize;
}

/** 确定性估算实现，测试专用 */
export function createApproxMeasurer(): TextMeasurer {
  return {
    measure(text: string, fontSize: number): number {
      return estimateTextWidth(text, fontSize);
    },
  };
}

/** 按最大宽度折行（用于注释和多行消息标签）。按字符折，中英文混排都能处理。 */
export function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measurer: TextMeasurer,
  fontFamily: string,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const ch of paragraph) {
      const candidate = current + ch;
      if (current !== '' && measurer.measure(candidate, fontSize, fontFamily) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}
