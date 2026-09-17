/**
 * Redis 模块的各个槽位。
 *
 * 外壳只认 `Module` 接口，它把这些组件填进去：
 *   Sidebar（左） / Main（中） / Inspector（右） / StatusItems（状态栏右侧）
 *
 * **刻意没有 Toolbar** —— 这个模块不需要顶部通栏，正好也验证了 `Toolbar?`
 * 真的是可选的（`Module` 接口里它是唯一的可选组件槽）。
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { formatElapsed } from './core/render';
import { ConnectionForm } from './panels/ConnectionForm';
import { ConnectionList } from './panels/ConnectionList';
import { Console } from './panels/Console';
import { redisStore } from './state/store';

/** 订阅模块自己的 store。外壳不掺和模块的状态 */
function useRedis() {
  const state = useSyncExternalStore(redisStore.subscribe, redisStore.getSnapshot);
  return { state };
}

export function RedisSidebar(): ReactNode {
  const { state } = useRedis();
  return <ConnectionList state={state} store={redisStore} />;
}

export function RedisMain(): ReactNode {
  const { state } = useRedis();
  return <Console state={state} store={redisStore} />;
}

export function RedisInspector(): ReactNode {
  const { state } = useRedis();
  return <ConnectionForm state={state} store={redisStore} />;
}

/** 状态栏右侧：当前连接、库号、上一条命令的往返耗时 */
export function RedisStatusItems(): ReactNode {
  const { state } = useRedis();
  const profile = redisStore.selectedProfile();
  const runtime = profile ? state.runtime[profile.id] : undefined;

  if (!profile) {
    return (
      <span className="rd-muted" data-testid="conn-status">
        没有连接
      </span>
    );
  }

  return (
    <>
      <span className="rd-muted" data-testid="conn-status">
        {profile.name} · {profile.host}:{profile.port}/{profile.db} · {statusText(runtime?.status)}
      </span>
      {runtime?.lastElapsedMs != null && (
        <span className="rd-muted" data-testid="conn-elapsed">
          上次 {formatElapsed(runtime.lastElapsedMs)}
        </span>
      )}
    </>
  );
}

function statusText(status: string | undefined): string {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'connecting':
      return '连接中';
    case 'error':
      return '连接出错';
    default:
      return '未连接';
  }
}
