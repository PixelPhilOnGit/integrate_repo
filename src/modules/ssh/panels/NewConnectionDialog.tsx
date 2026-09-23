/**
 * 「新建 SSH 连接 / 本地终端」弹框。
 *
 * # 这里原来有两个按钮
 *
 * 「新建」（= SSH 连接）和「本地」（= 本地终端）各一个，点一下直接建出来。
 * 那种做法的问题是**它替你决定了种类** —— 用户想建本地终端却点了上面那个，
 * 得到的是一个要填主机和密码的东西。现在合并成一个入口 + 弹框里选种类
 * （用户拍板的）。代价是建本地终端多一步，所以那一格**选完就没有别的必填项**
 * 了：`validateProfile` 在 `kind === 'local'` 时只查名字，而名字是预填的。
 *
 * # 草稿是一份「还没进 store 的档案」
 *
 * `newProfile` 已经把默认值和去重过的名字填好了，所以它直接就是一个合法的
 * `SshProfile` —— 校验、默认值、去重、换种类联动全部原样复用。
 *
 * ⚠️ 但它**不进 store、不落盘**：取消时跟着组件一起消失。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionDialog, dialogCanSubmit } from '../../../shared/connections/ConnectionDialog';
import { applyNewDialogKindSwitch, newProfile, validateProfile } from '../core/profile';
import { KIND_LABEL, type SshProfileKind } from '../core/types';
import type { SshState, SshStore } from '../state/store';

interface Props {
  state: SshState;
  store: SshStore;
  onClose: () => void;
}

export function NewConnectionDialog({ state, store, onClose }: Props): ReactNode {
  const [draft, setDraft] = useState(() => newProfile(state.profiles));

  const errors = validateProfile(draft);
  // ⚠️ 主按钮只看**弹框里那几个字段**。拿完整校验当判据的话，这个按钮**永远
  // 是灰的** —— 默认档案的密码是空的，而密码不在弹框里（`validateProfile`
  // 要求密码认证必须有密码）。用户看不出为什么：每个字段他都填好了。
  // 这是 e2e 抓出来的（「element is not enabled」）。
  //
  // ⚠️ 选「本地终端」时那几个字段**没有错误** —— `validateProfile` 在
  // `kind === 'local'` 时早返回、只查名字，所以按钮立刻可点（那是刻意的：
  // 本地终端没有别的必填项，别让用户多点两下）。
  const valid = dialogCanSubmit(errors);
  const isLocal = draft.kind === 'local';

  const submit = (): void => {
    if (!valid) return;
    // ⚠️ `kind` 单独传（它是唯一来源），草稿只提供其余字段。
    void store.createProfile(draft.kind, draft);
    onClose();
  };

  return (
    <ConnectionDialog
      testIdPrefix="ssh-new"
      title="新建连接"
      hint={
        isLocal
          ? '本地终端在本机起一个 shell —— 主机、用户名、密码那些都用不上。'
          : '认证方式、密码 / 私钥在右边那一栏填。'
      }
      values={draft}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      errors={errors}
      valid={valid}
      // ⚠️ 选「本地终端」时那一段**整块隐藏**，不是禁用 —— 和右侧表单一个处理
      // （那里也是 `{profile.kind === 'ssh' && (...)}`）。主机/端口/用户名对本地
      // 终端毫无意义，画三个灰框只是噪音。
      showMachine={!isLocal}
      onCancel={onClose}
      onConfirm={submit}
      extra={
        <label className="rd-field">
          <span>种类</span>
          <select
            data-testid="ssh-new-kind"
            value={draft.kind}
            onChange={(e) => {
              const next = e.target.value as SshProfileKind;
              // ⚠️ 走 `applyNewDialogKindSwitch` 而不是直接改 kind：它负责把名字
              // 一起联动过去（且只动用户没碰过的那个）。
              setDraft((d) => applyNewDialogKindSwitch(state.profiles, d, next));
            }}
          >
            {(Object.keys(KIND_LABEL) as SshProfileKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
      }
    />
  );
}
