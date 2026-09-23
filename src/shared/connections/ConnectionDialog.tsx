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
 * # 为什么不做这三件事
 *
 * * **背板点击关闭** —— 全仓 5 个弹框一个都没做。真要做的话得用 `onMouseDown` +
 *   `e.target === e.currentTarget`：用 `onClick` 会把「在弹框里拖选文字、松手
 *   落在背板上」也算成一次点击，于是用户复制个密码就把弹框关了。
 * * **Enter 提交** —— 仓里的弹框都是裸 `<label>`，没有 `<form>`。
 * * **焦点圈** —— 没有先例。
 *
 * 这三条都属于「要做就全仓一起做」，单独给这一个弹框加会变成特例。
 *
 * # 主按钮那个类
 *
 * `rd-btn-primary` 全仓有 7 个 tsx 挂着，但 **CSS 里一个字都没有**（按钮样式
 * 走的是 `button` 元素选择器）。这里不动全局 —— 加一条全局规则会顺手改掉
 * agents 那几个弹框的外观。样式表里那两条规则**限定在 `.rd-conn-dialog` 里**。
 */

import { useEffect, type ReactNode } from 'react';

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
  valid,
  confirmLabel = '新建',
  onCancel,
  onConfirm,
}: ConnectionDialogProps): ReactNode {
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

  const fieldError = (field: ConnectionDialogField): ReactNode =>
    errors?.[field] !== undefined ? (
      <p className="rd-hint is-error" data-testid={`${p}-${field}-error`}>
        {errors[field]}
      </p>
    ) : null;

  return (
    <div className="rd-modal-backdrop rd-conn-dialog" data-testid={`${p}-dialog`}>
      <div className="rd-modal" role="dialog" aria-modal="true" aria-labelledby={`${p}-title`}>
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
