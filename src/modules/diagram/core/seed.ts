/**
 * 浏览器版虚拟工作区的初始内容。
 *
 * 由 `main.tsx`（组合根）注入给平台层 —— 平台层不认识任何模块的文档格式，
 * 这里也不该知道平台层怎么存。
 */

import type { SeedFile } from '../../../shared/platform/config';
import { FILE_EXT } from './model';
import { createNewDoc } from './samples';
import { serializeDoc } from './schema';
import { defaultTheme } from './theme';

export function diagramSeed(): SeedFile[] {
  const doc = createNewDoc('未命名');
  doc.participants[0]!.name = '用户';
  doc.participants[1]!.name = '服务端';
  return [
    { path: `示例${FILE_EXT}`, content: serializeDoc(doc) },
    {
      path: `归档/旧版${FILE_EXT}`,
      content: serializeDoc(createNewDoc('旧版', defaultTheme())),
    },
  ];
}
