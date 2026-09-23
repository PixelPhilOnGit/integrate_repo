/**
 * 「新建 Redis 连接」弹框。
 *
 * 壳（背板 / 标题 / 四个通用字段 / Esc / 动作行）在
 * `shared/connections/ConnectionDialog.tsx`，这里只管**这个模块特有**的三件事：
 * 草稿从哪来、多出来那一格（库号）、校验用哪份规则。
 *
 * # 草稿是一份「还没进 store 的档案」
 *
 * `newProfile` 已经把默认值和去重过的名字都填好了，所以它**直接就是一个合法的
 * `ConnectionProfile`** —— 校验、默认值、去重全部原样复用，不用为弹框另写一套。
 *
 * ⚠️ 但它**不进 store、不落盘**：用户点取消时它跟着组件一起消失，没有要擦的痕迹。
 * 这也是为什么不做「先建后填、取消时删」—— 那样取消会变成一次破坏性操作，
 * 而且切模块时面板卸载，那份空档案就**没人删得掉**了。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionDialog } from '../../../shared/connections/ConnectionDialog';
import { hasErrors, newProfile, validateProfile } from '../core/profile';
import type { RedisState, RedisStore } from '../state/store';

interface Props {
  state: RedisState;
  store: RedisStore;
  onClose: () => void;
}

export function NewConnectionDialog({ state, store, onClose }: Props): ReactNode {
  // 惰性初始化：只在挂载时算一次。弹框每次开都是重新挂载的，所以不会残留上次的输入。
  const [draft, setDraft] = useState(() => newProfile(state.profiles));

  const errors = validateProfile(draft);
  // ⚠️ 这个模块能直接用**完整校验**，和 SQL / SSH 不一样 —— 因为 Redis 的连接
  // 字段**全都在弹框里**（连库号都在，密码是唯一可选的）。SQL 的库名、SSH 的
  // 密码都不在弹框里，它们得用 `dialogCanSubmit` 只看弹框里那几个字段，
  // 否则按钮会永远是灰的（见那个函数的注释）。
  const valid = !hasErrors(errors);

  const submit = (): void => {
    if (!valid) return;
    // ⚠️ 把整份草稿传进去 —— `createProfile` 只取字段值，id 用它自己生成的那个
    // （草稿那个 id 只用于 React 的 key，理由见 `core/profile.ts` 的 `ProfileInit`）。
    void store.createProfile(draft);
    onClose();
  };

  return (
    <ConnectionDialog
      testIdPrefix="redis-new"
      title="新建 Redis 连接"
      hint="库号、密码这些在右边那一栏填。"
      values={draft}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      errors={errors}
      valid={valid}
      onCancel={onClose}
      onConfirm={submit}
      extra={
        <label className="rd-field">
          <span>库号</span>
          <input
            data-testid="redis-new-db"
            type="number"
            inputMode="numeric"
            // 清空输入框时 `Number('')` 是 0、`Number('x')` 是 NaN ——
            // 都不是能显示的东西，所以只认有限数，其余画成空串。
            value={Number.isFinite(draft.db) ? draft.db : ''}
            onChange={(e) => setDraft((d) => ({ ...d, db: Number(e.target.value) }))}
          />
        </label>
      }
    />
  );
}
