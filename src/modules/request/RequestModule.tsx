/**
 * 「接口调试」的各个槽位。
 *
 * 外壳只认 `Module` 接口，它把这些组件填进去：
 *   Toolbar（顶部通栏） / Sidebar（左） / Main（中） / Inspector（右） / StatusItems
 *
 * 分工和另外几个模块一致：**侧栏导航、主区干活、检查器改选项**。
 *
 * ⚠️ 这里**没有 Toolbar 之外的快捷键**：调接口时最常用的动作是「发送」，
 * 而它已经绑在地址栏的回车上了（在那一栏里按回车 = 发送）——
 * 再抢一个全局 Ctrl+Enter 的话，会和别的模块的快捷键抢地盘，
 * 而收益只是省一次 Tab。
 *
 * ⚠️ 它**没有角标**（`Module.badge`）：角标的意义是「用户在别的模块里时
 * 也能看见的提醒」，而请求是秒级的事 —— 转一圈就完了，没有必要去别的
 * 模块里叫他。这和「智能体会话等你审批」「任务还没做完」是两回事。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { formatMillis } from './core/format';
import { RequestInspectorView } from './panels/Inspector';
import { RequestMainView } from './panels/Main';
import { RequestSidebarView } from './panels/Sidebar';
import { RequestToolbarView } from './panels/Toolbar';
import { requestStore } from './state/store';

/** 订阅模块自己的 store。外壳不掺和模块的状态 */
function useRequest() {
  return useSyncExternalStore(requestStore.subscribe, requestStore.getSnapshot);
}

export function RequestToolbar(): ReactNode {
  return <RequestToolbarView state={useRequest()} store={requestStore} />;
}

export function RequestSidebar(): ReactNode {
  return <RequestSidebarView state={useRequest()} store={requestStore} />;
}

export function RequestMain(): ReactNode {
  return <RequestMainView state={useRequest()} store={requestStore} />;
}

export function RequestInspector(): ReactNode {
  return <RequestInspectorView state={useRequest()} store={requestStore} />;
}

/** 状态栏右侧：最近一次请求的状态码和耗时 */
export function RequestStatusItems(): ReactNode {
  const { response } = useRequest();
  if (response.head === null) return null;

  return (
    <span className="rd-status-item" data-testid="request-status-item">
      {response.head.status} {response.head.reason} · {formatMillis(response.head.elapsedMillis)}
      {response.phase === 'running' ? '（还在收）' : ''}
    </span>
  );
}
