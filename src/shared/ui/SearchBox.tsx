/**
 * 侧栏顶上那个搜索框。
 *
 * # 它只负责「输入 + 清空」，过滤交给各模块
 *
 * 五个侧栏的形状不一样（连接 → 会话 / 连接 → 库 → 表 / 目录 → 文件），
 * 「查到什么算什么」这件事差别很大，所以过滤在各模块自己的面板里做；
 * 这里只管**长什么样、怎么清空**，五个地方保持一致。
 *
 * # 为什么是 `type="text"` 而不是 `type="search"`
 *
 * `search` 会带出浏览器原生的那个清空小叉，和我们自己的按钮**并排出现两个叉**，
 * 而且那个叉在不同 WebView 里长得不一样。自己画一个，位置和样式就都归我们管。
 *
 * # Esc 清空
 *
 * 搜索框里的常规手势，而且不用去够那个小叉。⚠️ 要 `stopPropagation`：
 * 外壳（和某些面板）也监听 Esc（关菜单、取消重命名），不清掉的话按一下
 * 会连带把别的东西也关了。
 */

import type { ReactNode } from 'react';
// Vite 会把它跟组件一起打包；为什么单独一个文件见那个文件的头部
import './SearchBox.css';

export interface SearchBoxProps {
  value: string;
  onChange: (next: string) => void;
  /**
   * 测试用的 testid。**必填**：五个侧栏各要一个稳定的选择器，
   * 而「按 placeholder 选」在文案一改就碎。
   */
  testId: string;
  placeholder?: string;
}

export function SearchBox({
  value,
  onChange,
  testId,
  placeholder = '搜索…',
}: SearchBoxProps): ReactNode {
  return (
    <div className="rd-search">
      <input
        type="text"
        className="rd-search-input"
        data-testid={testId}
        placeholder={placeholder}
        value={value}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          // 空的时候不拦：那时候用户按 Esc 想关的多半是别的东西
          if (value !== '') onChange('');
        }}
      />
      {value !== '' && (
        <button
          type="button"
          className="rd-search-clear"
          data-testid={`${testId}-clear`}
          aria-label="清空搜索"
          title="清空"
          onClick={() => onChange('')}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * 过滤之后什么都没剩下时显示的那一行。
 *
 * 抽出来是因为**五个侧栏都要有**：空的侧栏看起来像「坏了」，
 * 而一句「没有匹配的」直接回答了「是我搜错了还是它没加载」。
 */
export function NoMatch({ testId }: { testId: string }): ReactNode {
  return (
    <div className="rd-empty" data-testid={testId}>
      没有匹配的
    </div>
  );
}
