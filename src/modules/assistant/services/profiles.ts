/**
 * 助手配置的持久化。
 *
 * 和连接档案共用 `shared/connections/profiles.ts` 那一层 —— 形状是一样的
 *（「一堆有 id 和 name 的记录，整个数组存一个键」），所以直接用它的
 * `createProfileStore`，连 `sanitize` 的写法都一样。
 *
 * ⚠️ **不用 `createSecretProfileStore`**：那个是给「敏感字段在记录里」的
 *（连接密码、私钥口令会跟着记录走）。助手的 API key **不在配置里** ——
 * 它是系统钥匙串里一条独立的凭据，而且**只写不读**（见 `services/types.ts`）。
 * 硬套那一层会把「敏感字段在记录里」这个前提搞错。
 */

import { createProfileStore } from '../../../shared/connections/profiles';
import type { ProfileStore } from '../../../shared/connections/types';
import type { KeyValueStore } from '../../../shared/platform/kv';
import { PROFILES_KEY, coerceProfiles, type ProviderProfile } from '../core/config';

/** 建一份配置的存储（`load` / `save` 两个动作，整个数组一起）。 */
export function createAssistantProfileStore(
  kv: KeyValueStore,
): ProfileStore<ProviderProfile> {
  return createProfileStore<ProviderProfile>(kv, {
    key: PROFILES_KEY,
    sanitize: coerceProfiles,
  });
}
