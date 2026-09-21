import type { ReactNode } from 'react';

/**
 * 助手的图标：一个对话气泡，里面是**三点还没连成线**。
 *
 * 为什么不是勾、不是星：这个模块的定位是"还在成形的东西"（一期只有配置），
 * 而一个画得满满当当的图标会让人以为它已经能干活了。三点也是「正在想」的
 * 通用画法，等真正接上模型再换成实心的。
 */
export function AssistantIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 气泡 */}
      <path d="M3 6.5a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 17 6.5v5a2.5 2.5 0 0 1-2.5 2.5H8l-3.5 3v-3H5.5A2.5 2.5 0 0 1 3 11.5z" />
      {/* 三点 */}
      <circle cx="7.2" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.8" cy="9" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
