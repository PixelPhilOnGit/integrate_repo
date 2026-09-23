/**
 * 主区：上面是**要发的请求**，下面是**它回来的东西**。
 *
 * 上下分栏（不是左右）是有意的：调接口时两边最重要的一列都是**长字符串**
 *（地址、正文、响应体），左右分的话两边都只能看到半行。
 *
 * 两块都常驻（响应那块自己有空态），不做「收完才显示」的切换 ——
 * 那会让界面在发送之后闪一下。
 */

import type { ReactNode } from 'react';
import type { RequestState, RequestStore } from '../state/store';
import { RequestEditorView } from './Editor';
import { ResponseView } from './Response';

export interface RequestMainProps {
  state: RequestState;
  store: RequestStore;
}

export function RequestMainView({ state, store }: RequestMainProps): ReactNode {
  return (
    <div className="rd-req-main" data-testid="request-main">
      <RequestEditorView state={state} store={store} />
      <ResponseView state={state} store={store} />
    </div>
  );
}
