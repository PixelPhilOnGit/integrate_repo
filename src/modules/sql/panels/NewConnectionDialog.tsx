/**
 * 「新建 SQL 连接」弹框。
 *
 * 壳在 `shared/connections/ConnectionDialog.tsx`，这里管这个模块特有的三件事：
 * 草稿从哪来、**引擎那一格**、以及换引擎时的联动。
 *
 * # 引擎那一格为什么在最上面
 *
 * 因为它决定下面所有字段的默认值（端口 5432/3306/8123/27017、用户名、库名、
 * 连名字前缀都不一样）。先选引擎再填端口，不会出现「填完 5432 再切成 MySQL
 * 被改成 3306」那种观感 —— 虽然 [`applyNewDialogKindSwitch`] 的规则是自洽的
 * （它只改用户没动过的），但顺序对了就没人会去想这件事。
 *
 * # 草稿是一份「还没进 store 的档案」
 *
 * `newProfile` 已经把默认值和去重过的名字都填好了，所以它直接就是一个合法的
 * `SqlProfile` —— 校验、默认值、去重、换引擎联动全部原样复用。
 *
 * ⚠️ 但它**不进 store、不落盘**：取消时跟着组件一起消失。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionDialog, dialogCanSubmit } from '../../../shared/connections/ConnectionDialog';
import { applyNewDialogKindSwitch, newProfile, validateProfile } from '../core/profile';
import { KIND_LABEL, KIND_ORDER, type SqlKind } from '../core/types';
import type { SqlState, SqlStore } from '../state/store';

interface Props {
  state: SqlState;
  store: SqlStore;
  /**
   * 从哪个入口进来的。
   *
   * 分组头那个「＋」会把引擎**定死**（它的原意就是「在这一组里加一条」
   * —— 那组按引擎分，见 `ConnectionTree`）；「新建」按钮进来则是默认引擎，
   * 用户自己在弹框里选。
   */
  kind?: SqlKind;
  onClose: () => void;
}

export function NewConnectionDialog({
  state,
  store,
  kind = 'postgres',
  onClose,
}: Props): ReactNode {
  const [draft, setDraft] = useState(() => newProfile(state.profiles, kind));

  const errors = validateProfile(draft);
  // ⚠️ 主按钮只看**弹框里那几个字段** —— 库名、密码不在弹框里，空着是正常的
  // （用户待会儿去右边填）。拿完整校验当判据的话按钮可能一直是灰的，而用户
  // 看不出为什么。理由写在 `dialogCanSubmit` 的注释里。
  const valid = dialogCanSubmit(errors);

  const submit = (): void => {
    if (!valid) return;
    // ⚠️ `kind` 单独传（它是唯一来源），草稿只提供其余字段。
    void store.createProfile(draft.kind, draft);
    onClose();
  };

  return (
    <ConnectionDialog
      testIdPrefix="sql-new"
      title="新建连接"
      hint="库名、密码这些在右边那一栏填。"
      values={draft}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      errors={errors}
      valid={valid}
      onCancel={onClose}
      onConfirm={submit}
      extra={
        <label className="rd-field">
          <span>引擎</span>
          <select
            data-testid="sql-new-kind"
            value={draft.kind}
            onChange={(e) => {
              const next = e.target.value as SqlKind;
              // ⚠️ 走 `applyNewDialogKindSwitch` 而不是直接改 kind：它负责把
              // 端口/用户名/库名/名字一起联动过去（且只动用户没碰过的那些）。
              setDraft((d) => applyNewDialogKindSwitch(state.profiles, d, next));
            }}
          >
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
}
