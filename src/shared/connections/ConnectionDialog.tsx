/**
 * 「新建连接」弹框的**壳**。
 *
 * 三个连接模块（Redis / SQL / SSH）点「新建」时都弹它，但每个模块的字段和
 * 校验规则不一样，所以这里只管**结构完全相同**的那部分：
 *
 *   背板 / 标题 / 四个通用字段 / 动作行 / Esc
 *
 * 各模块特有那一格（SQL 的引擎、Redis 的库号、SSH 的种类）走 `extra` 插槽，
 * 画在**最上面** —— 它决定下面那些字段的默认值，所以得先问。
 *
 * ⚠️ **这一层不认识任何具体模块**：它只认下面 [`ConnectionDialogValues`] 那四个
 * 字段，不 import `SqlKind` / `SshProfile` 之类。这是 `shared/connections/` 那条
 * 界线（见 `types.ts` 的头注释）—— 这层是给连接类模块共用的，不是给某一个用的。
 *
 * # 焦点圈 / Enter 提交 / 背板点击
 *
 * 前两件在 2026-10-15 那一轮补齐了：「要做就全仓一起做」的那个全仓 =
 * `shared/ui/useModalKeys.ts`（焦点圈 + 进场焦点 + 退场还焦点 + 回车提交），
 * 全仓五个弹框都挂上了它。**背板点击关闭**仍然不做，理由不变：用 `onClick`
 * 会把「在弹框里拖选文字、松手落在背板上」也算成一次点击，于是用户复制个
 * 密码就把弹框关了。
 *
 * # 主按钮那个类
 *
 * `rd-btn-primary` 在 2026-10-15 那一轮已收编成全局规则（实心强调色）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useModalKeys } from '../ui/useModalKeys';
import { groupPath } from './groups';
import type { ConnectionGroup } from './types';

/** 下拉里那个「动作选项」的哨兵值。目录 id 是随机生成的，撞不上 */
const NEW_GROUP_OPTION = '__new_group__';

/**
 * 弹框里那四个通用字段。
 *
 * ⚠️ `port` 是 **number** 不是字符串 —— 和右侧表单的输入框同一手写法，
 * 不为弹框单独造一套「字符串草稿」。输入框里那点转换在下面。
 */
export interface ConnectionDialogValues {
  name: string;
  host: string;
  port: number;
  username: string;
  /**
   * 「本地终端用哪个 shell」（SSH 的本地连接用；别的模块没有这个字段）。
   * `''` = 平台默认。
   */
  localShell?: string;
}

/** 四个通用字段里，哪几个会画错误提示。 */
export type ConnectionDialogField = keyof ConnectionDialogValues;

export interface ConnectionDialogProps {
  /**
   * testid 前缀。整套 id 由它派生：
   * `${p}-dialog` / `-name` / `-host` / `-port` / `-username` / `-cancel` / `-confirm`。
   *
   * 各模块自己那一格（引擎/库号/种类）该用**同一个前缀**写死，比如 `sql-new-kind`。
   */
  testIdPrefix: string;
  /** 弹框标题。 */
  title: string;
  /** 标题下面那句话 —— 三个模块都用它回答「为什么只有这几个字段」。 */
  hint?: ReactNode;
  /** 模块特有的那一格。见头部注释（画在最上面）。 */
  extra?: ReactNode;
  /** 受控值。直接把草稿档案传进来就行（多几个字段不影响结构兼容）。 */
  values: ConnectionDialogValues;
  /** 改一个或几个字段。 */
  onChange: (patch: Partial<ConnectionDialogValues>) => void;
  /**
   * 校验结果，按字段画在输入框下面。
   *
   * ⚠️ 规则来自各模块自己的 `validateProfile` —— **别手搓一个字面量**，
   * 直接把它的返回值传进来（类型比这里宽，传参不受多余属性检查限制）。
   */
  errors?: Partial<Record<ConnectionDialogField, string>>;
  /** 主机 / 端口 / 用户名那一段画不画。SSH 选「本地终端」时传 `false`。 */
  showMachine?: boolean;
  /**
   * 「本地终端用哪个 shell」那一格。**传了才画**（SSH 的本地终端用；
   * 2026-10-16 用户提的：建的时候就要能选 cmd / PowerShell —— 此前这个选择
   * 只在建完之后的属性面板里有，等于藏起来了）。
   *
   * 选项由模块给（壳不认识「shell 有哪些」），值是受控的
   * `values.localShell`。
   */
  localShellOptions?: ReadonlyArray<{ value: string; label: string }>;
  /**
   * 目录树 + 当前选中的目录 —— 画「所在目录」下拉用。
   * **不传就整格不画**（别的调用方一个字不动）。`ConnectionGroup` 就在
   * `shared/connections` 里，壳认识它不破边界（见文件头那条线）。
   */
  groups?: readonly ConnectionGroup[];
  /** 选中的目录（`undefined`/`null` = 未分组/顶层）。 */
  groupId?: string | null;
  /** 换目录。传 `null` = 未分组/顶层 */
  onGroupChange?: (groupId: string | null) => void;
  /**
   * 在这个弹框里新建一个目录（下拉里的「＋ 新建目录…」，2026-10-15 体验评审：
   * 建连接是最常建目录的时刻，此前只能「先建连接 → 再右键移入」）。
   * 传了才画那个选项；返回新目录 id（失败返回 null = 不选中任何新目录）。
   * ⚠️ 由调用方实现（store 的 createGroup + renameGroup），壳不认识模块。
   */
  onCreateGroup?: (name: string) => Promise<string | null>;
  /** 主按钮能不能点。**由模块算** —— 三边的校验规则差太多。 */
  valid: boolean;
  /** 主按钮的文字。 */
  confirmLabel?: string;
  /** 取消 / Esc 都走它。⚠️ 调用方在这里**什么都不该建**。 */
  onCancel: () => void;
  /** 确认。调用方在这里才真的建。 */
  onConfirm: () => void;
}

/**
 * 主按钮该不该亮 —— **只看弹框里那四个字段**。
 *
 * ⚠️ **不能拿完整的 `validateProfile` 结果当判据。** 弹框刻意只收集关键字段，
 * 密码 / 认证方式 / 私钥路径都留在右边那一栏 —— 它们空着是**正常的**。
 * 拿完整校验当判据的话，新建 SSH 连接时那个按钮**永远是灰的**（默认档案的
 * 密码是空的），而且用户完全看不出为什么：弹框里每个字段他都填好了。
 *
 * 这条是 e2e 抓出来的（`ssh-new-confirm` 一直 disabled，报的是
 * 「element is not enabled」）。
 *
 * `undefined` 之外的值都算错 —— 各模块传的是自己的 `ProfileErrors`，
 * 里面塞的是中文文案。
 */
export function dialogCanSubmit(errors: Partial<Record<string, string | undefined>>): boolean {
  return (
    errors['name'] === undefined &&
    errors['host'] === undefined &&
    errors['port'] === undefined &&
    errors['username'] === undefined
  );
}

export function ConnectionDialog({
  testIdPrefix: p,
  title,
  hint,
  extra,
  values,
  onChange,
  errors,
  showMachine = true,
  localShellOptions,
  groups,
  groupId,
  onGroupChange,
  onCreateGroup,
  valid,
  confirmLabel = '新建',
  onCancel,
  onConfirm,
}: ConnectionDialogProps): ReactNode {
  // 「＋ 新建目录…」的内联输入（草稿在壳里，建的动作也由壳发起 —— 但真正
  // 落库的是调用方传进来的 onCreateGroup）
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupDraft, setNewGroupDraft] = useState('');

  const commitNewGroup = async (): Promise<void> => {
    if (onCreateGroup === undefined) return;
    const name = newGroupDraft.trim();
    if (name === '') return;
    const id = await onCreateGroup(name);
    setNewGroupOpen(false);
    setNewGroupDraft('');
    if (id !== null) onGroupChange?.(id);
  };
  // Escape 关掉。放在 effect 里而不是直接挂 onKeyDown：弹框是条件渲染的，
  // 挂在 div 上要求它先拿到焦点 —— 而焦点这会儿还在别处（用户刚点的那个按钮）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  // 焦点圈 + 回车提交（评审：键盘用户要 Tab 6 次才到「新建」，第 7 次还会
  // 走到弹框背后）。校验不过时不给回车语义 —— 灰着的按钮不该被回车绕过去。
  const modalRef = useRef<HTMLDivElement>(null);
  useModalKeys({ ref: modalRef, onSubmit: valid ? onConfirm : undefined });

  const fieldError = (field: ConnectionDialogField): ReactNode =>
    errors?.[field] !== undefined ? (
      <p className="rd-hint is-error" data-testid={`${p}-${field}-error`}>
        {errors[field]}
      </p>
    ) : null;

  return (
    <div className="rd-modal-backdrop rd-conn-dialog" data-testid={`${p}-dialog`}>
      <div
        className="rd-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${p}-title`}
      >
        <h2 className="rd-modal-title" id={`${p}-title`}>
          {title}
        </h2>
        {hint !== undefined && <p className="rd-hint rd-muted">{hint}</p>}

        <div className="rd-form">
          {extra}

          <label className="rd-field">
            <span>名字</span>
            <input
              data-testid={`${p}-name`}
              value={values.name}
              // ⚠️ 焦点落在**名字**上：它已经被预填成去重过的默认名，用户要么
              // 直接 Tab 走、要么改成自己要的 —— 两种都从这儿起步最顺。
              autoFocus
              onChange={(e) => onChange({ name: e.target.value })}
            />
          </label>
          {fieldError('name')}

          {showMachine && (
            <>
              <label className="rd-field">
                <span>主机</span>
                <input
                  data-testid={`${p}-host`}
                  value={values.host}
                  placeholder="127.0.0.1 或 db.example.com"
                  onChange={(e) => onChange({ host: e.target.value })}
                />
              </label>
              {fieldError('host')}

              <label className="rd-field">
                <span>端口</span>
                <input
                  data-testid={`${p}-port`}
                  type="number"
                  inputMode="numeric"
                  // 清空输入框时 `Number('')` 是 0、`Number('x')` 是 NaN ——
                  // 都不是能显示的东西，所以只认有限数，其余画成空串。
                  value={Number.isFinite(values.port) ? values.port : ''}
                  onChange={(e) => onChange({ port: Number(e.target.value) })}
                />
              </label>
              {fieldError('port')}

              <label className="rd-field">
                <span>用户名</span>
                <input
                  data-testid={`${p}-username`}
                  value={values.username}
                  onChange={(e) => onChange({ username: e.target.value })}
                />
              </label>
              {fieldError('username')}
            </>
          )}

          {/* 「所在目录」：建完直接落进目录里 —— 省掉「先建再右键移入」那两步
              （用户报过那个顺序别扭，见 HANDOFF 的目录树那一节）。
              「＋ 新建目录…」是 2026-10-15 体验评审补的：建连接往往正是
              第一次想建目录的时刻，不该逼用户关掉弹框去建 */}
          {localShellOptions !== undefined && (
            <label className="rd-field">
              <span>用哪个 shell</span>
              <select
                data-testid={`${p}-local-shell`}
                value={values.localShell ?? ''}
                onChange={(e) => onChange({ localShell: e.target.value })}
              >
                {localShellOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="rd-hint rd-muted">
                本地终端在本机起一个 shell。要 cmd 和 PowerShell 各来一个，
                就建两条本地连接、这里各选各的；建完还能在右边属性面板里改。
              </p>
            </label>
          )}

          {groups !== undefined && onGroupChange !== undefined && (
            <label className="rd-field">
              <span>所在目录</span>
              <select
                data-testid={`${p}-group`}
                value={groupId ?? ''}
                onChange={(e) => {
                  if (e.target.value === NEW_GROUP_OPTION) {
                    setNewGroupOpen(true);
                    return;
                  }
                  setNewGroupOpen(false);
                  onGroupChange(e.target.value === '' ? null : e.target.value);
                }}
              >
                <option value="">（未分组）</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {groupPath(groups, g.id)}
                  </option>
                ))}
                {onCreateGroup !== undefined && (
                  <option value={NEW_GROUP_OPTION}>＋ 新建目录…</option>
                )}
              </select>
            </label>
          )}

          {newGroupOpen && onCreateGroup !== undefined && (
            <label className="rd-field">
              <span>目录名</span>
              <input
                data-testid={`${p}-group-name`}
                // ⚠️ 这个框的回车有主（建目录），别让弹框的「提交」抢走
                data-modal-enter-ignore="true"
                value={newGroupDraft}
                autoFocus
                onChange={(e) => setNewGroupDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void commitNewGroup();
                  }
                }}
              />
              <button
                type="button"
                data-testid={`${p}-group-confirm`}
                disabled={newGroupDraft.trim() === ''}
                onClick={() => void commitNewGroup()}
              >
                建
              </button>
            </label>
          )}
        </div>

        <div className="rd-modal-actions">
          <button type="button" data-testid={`${p}-cancel`} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            data-testid={`${p}-confirm`}
            disabled={!valid}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
