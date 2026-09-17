/**
 * 「顺序图文件」这个文件类型的全部前端知识。
 *
 * 集中在一处的理由：`.seq.json` 以前散落在 Rust、平台层、组件三层共 7 处，
 * 想改个扩展名得满仓库找。这里是**前端**的收敛点。
 *
 * Rust 侧那几处（目录树过滤、新建补后缀、重命名特判）**暂时不动** ——
 * 泛化它们要加命令参数、改签名、连带改 Rust 测试，而第二个模块还没影，
 * 现在抽的抽象是凭猜测设计的。等真有模块需要列别的文件时一起做。
 */

import { FILE_EXT } from './model';

export const DIAGRAM_FILE_TYPE = {
  /** 磁盘上的后缀 */
  extension: FILE_EXT,

  /** 目录树里要不要列出这个文件 */
  isListable: (fileName: string): boolean =>
    fileName.toLowerCase().endsWith(FILE_EXT.toLowerCase()),

  /** 文件名 → 树上显示的名字（去掉后缀） */
  displayName: (fileName: string): string => fileName.replace(/\.seq\.json$/i, ''),
};
