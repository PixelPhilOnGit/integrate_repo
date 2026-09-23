/**
 * 左侧栏：连接 → 会话 的树。
 *
 * 和 Redis/SQL 那个「连接 → 库 → 表」的树是同一个形状，但**子节点是会话而不是
 * 服务端的结构** —— SSH 连上之后没有「库」这种东西可列，能列的就是你自己开的
 * 那几个终端。所以展开一个连接看到的是它的标签，点一下就切过去。
 *
 * 标签栏在主区顶部还有一份。两处都保留是有意的：侧栏那份回答「我有哪几个会话」，
 * 主区那份回答「这些会话谁是谁」。终端用户习惯了两种都在。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionGroupRow } from '../../../shared/connections/ConnectionGroupRow';
import { assignGroups } from '../../../shared/connections/groups';
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import { KeychainNotice } from '../../../shared/connections/KeychainNotice';
import type { ConnectionGroup } from '../../../shared/connections/types';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { fuzzyBest } from '../../../shared/search';
import { addressOf } from '../core/profile';
import type { SshProfile, SshSession } from '../core/types';
import type { SshState, SshStore } from '../state/store';
import { NewConnectionDialog } from './NewConnectionDialog';

interface Props {
  state: SshState;
  store: SshStore;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ConnectionTree({ state, store }: Props): ReactNode {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [query, setQuery] = useState('');
  /** 哪些分组是收起来的。**纯显示状态，不持久化** */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  /** 正在行内改名的分组 id + 草稿（和文件树那套一样，不用弹窗） */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 「新建连接」弹框开着没有。开了才挂载，所以每次都是干净草稿。 */
  const [newOpen, setNewOpen] = useState(false);

  const q = query.trim();
  const searching = q !== '';

  // 匹配的是**连接自己**（名字/地址）或者**它下面的会话**（标题）。
  // 会话命中时那条连接也要留下 —— 否则用户搜一个会话名会得到「没有匹配的」。
  //
  // ⚠️ 保序（`filter` 而不是按分排序）：这里是一棵树，顺序就是用户摆出来的
  // 形状；边打字边重排会让人找不到刚才那一条。平铺的列表（Redis / SQL 的连接）
  // 才按相关度排。
  const visible = state.profiles.filter((profile) => {
    if (!searching) return true;
    if (fuzzyBest(q, [profile.name, addressOf(profile)]) !== null) return true;
    return store.sessionsOf(profile.id).some((s) => fuzzyBest(q, [s.title]) !== null);
  });

  // ⚠️ 搜索时才藏空组：**平时空组必须画出来**，用户刚点「＋组」建的就是空组，
  // 藏起来他会以为按钮坏了（见 `assignGroups` 的说明）
  const grouped = assignGroups(visible, state.groups, searching);

  /**
   * 搜索时**强制展开**所有分组 —— 命中的那条埋在收起来的分组里等于没搜到。
   *
   * ⚠️ 撑开是**临时的**（叠加在这一步），`collapsedGroups` 一个字不写：写进去的话，
   * 清空搜索之后被搜索撑开的分组会自己开着，用户手动收起来的那层就回不去了。
   * 文件树那边踩过同一个坑，规矩是一样的。
   */
  const isGroupCollapsed = (id: string): boolean => !searching && collapsedGroups[id] === true;
  const toggleGroup = (id: string): void =>
    setCollapsedGroups((c) => ({ ...c, [id]: !isGroupCollapsed(id) }));

  const commitRename = async (): Promise<void> => {
    const id = renaming;
    setRenaming(null);
    if (id === null || draft.trim() === '') return;
    await store.renameGroup(id, draft.trim());
  };

  /** 分组的右键菜单。删除分组**不需要确认弹窗**：它一条连接都不删（见 store 里那条注释） */
  const openGroupMenu = (group: ConnectionGroup, x: number, y: number): void => {
    setMenu({
      x,
      y,
      items: [
        {
          label: '重命名',
          onSelect: () => {
            setRenaming(group.id);
            setDraft(group.name);
          },
        },
        {
          // 把后果写在菜单里，比事后再弹一个确认框强 —— 用户点之前就该知道
          label: '删除分组（连接回到未分组）',
          danger: true,
          separatorBefore: true,
          onSelect: () => void store.deleteGroup(group.id),
        },
      ],
    });
  };

  /** 分组头（或者它被改名时的输入框） */
  const renderGroupHead = (group: ConnectionGroup, count: number): ReactNode => {
    if (renaming === group.id) {
      return (
        <div className="rd-conn-group-head" data-testid={`conn-group-rename-${group.id}`}>
          <span className="rd-agent-caret" />
          <input
            className="rd-rename-input"
            autoFocus
            value={draft}
            aria-label="重命名分组"
            data-testid="group-rename-input"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename();
              if (e.key === 'Escape') setRenaming(null);
              e.stopPropagation();
            }}
          />
        </div>
      );
    }
    return (
      <ConnectionGroupRow
        group={group}
        count={count}
        collapsed={isGroupCollapsed(group.id)}
        onToggle={() => toggleGroup(group.id)}
        onContextMenu={(x, y) => openGroupMenu(group, x, y)}
      />
    );
  };

  return (
    <div className="rd-panel rd-conn-list" data-testid="ssh-conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
        {/* 钥匙串用不了时提醒一句（桌面端才有；见 KeychainNotice） */}
        <KeychainNotice />
        <button type="button" data-testid="ssh-btn-new" onClick={() => setNewOpen(true)}>
          新建
        </button>
        {/*
          ⚠️ **这里原来还有一个「本地」按钮**（`ssh-btn-new-local`，点一下直接建一个
          本地终端）。2026-09-23 去掉了，种类改成在弹框里选。

          当时留两个按钮的理由是「点一下就是一个 SSH 连接，那个约定不该为了一个
          新种类去动」。用户反馈之后推翻了这个决定 —— 因为那两个按钮**替用户
          决定了种类**：想建本地终端却点了上面那个，得到的是一个要填主机和密码的
          东西，而且界面上看不出哪里不对。

          代价是建本地终端多一步（开弹框 → 选种类）。所以那一格选完就**没有别的
          必填项**了：`validateProfile` 在 `kind === 'local'` 时只查名字，而名字是
          预填好的 —— 两次点击、零输入。
        */}
        <button
          type="button"
          data-testid="ssh-btn-new-group"
          title="新建分组（把连接归归类）"
          onClick={() => void store.createGroup()}
        >
          ＋组
        </button>
      </div>

      {/* 一个连接都没有的时候不放搜索框：搜不到任何东西的框是噪音 */}
      {state.profiles.length > 0 && (
        <SearchBox
          value={query}
          onChange={setQuery}
          testId="ssh-conn-search"
          placeholder="搜连接或会话"
        />
      )}

      {state.profiles.length === 0 ? (
        <div className="rd-empty">还没有连接，点「新建」加一个</div>
      ) : visible.length === 0 ? (
        <NoMatch testId="ssh-conn-nomatch" />
      ) : (
        <div className="rd-panel-body">
          {/* 未分组的在最上面（也不缩进）：新建的连接就在这儿 */}
          {grouped.ungrouped.map((profile) => (
            <ConnectionBranch
              key={profile.id}
              profile={profile}
              state={state}
              store={store}
              onMenu={setMenu}
              query={q}
            />
          ))}

          {grouped.groups.map(({ group, items }) => (
            <div key={group.id}>
              {renderGroupHead(group, items.length)}
              {!isGroupCollapsed(group.id) && (
                <div className="rd-conn-group-body">
                  {items.map((profile) => (
                    <ConnectionBranch
                      key={profile.id}
                      profile={profile}
                      state={state}
                      store={store}
                      onMenu={setMenu}
                      query={q}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {newOpen && (
        <NewConnectionDialog state={state} store={store} onClose={() => setNewOpen(false)} />
      )}
    </div>
  );
}

function ConnectionBranch({
  profile,
  state,
  store,
  onMenu,
  query,
}: {
  profile: SshProfile;
  state: SshState;
  store: SshStore;
  onMenu: (menu: OpenMenu) => void;
  /** 当前搜索词（空串 = 没在搜）。用来决定「要不要临时撑开」 */
  query: string;
}): ReactNode {
  // ⚠️ 状态是**从会话列表推出来的**，不另存一份 —— 见 store 里 `statusOf` 的注释
  const status = store.statusOf(profile.id);
  const allSessions = store.sessionsOf(profile.id);
  const known = store.hostKeyFor(profile);

  /**
   * 搜索期间只显示命中的会话，并且**临时撑开**这条连接。
   *
   * ⚠️ 撑开是**临时叠加**在点击状态之上的，`store.expanded` 一个字都不动 ——
   * 否则清空搜索之后，用户手动折起来的那些连接会自己开着，树的形状回不去。
   */
  const searching = query.trim() !== '';
  const sessions = searching
    ? allSessions.filter((s) => fuzzyBest(query.trim(), [s.title]) !== null)
    : allSessions;
  const expanded = searching && sessions.length > 0 ? true : state.expanded[profile.id] === true;

  const openMenu = (x: number, y: number): void => {
    const items: MenuItem[] = [
      {
        label: '新建标签页',
        disabled: !store.canConnect(profile),
        onSelect: () => {
          store.select(profile.id);
          void store.connect(profile.id);
        },
      },
    ];

    if (allSessions.length > 0) {
      items.push({
        label: `关闭全部会话（${allSessions.length}）`,
        onSelect: () => {
          for (const session of allSessions) {
            void store.closeSession(session.id);
          }
        },
      });
    }

    // 「移入分组」：`ContextMenu` 没有子菜单，所以平铺列出来。
    // 分组通常只有几个，平铺比多一层菜单更好点 —— 而且当前的组会打勾，
    // 一眼看出这条连接现在在哪儿。
    if (state.groups.length > 0) {
      items.push(
        ...state.groups.map((group, i) => ({
          label: `移入「${group.name}」`,
          checked: profile.groupId === group.id,
          separatorBefore: i === 0,
          onSelect: () => void store.moveToGroup(profile.id, group.id),
        })),
      );
    }
    if (profile.groupId !== undefined) {
      items.push({
        label: '移出分组',
        onSelect: () => void store.moveToGroup(profile.id, null),
      });
    }

    if (known) {
      items.push({
        label: '忘记主机密钥',
        separatorBefore: true,
        onSelect: () => void store.forgetHost(profile.host, profile.port),
      });
    }

    items.push({
      label: '删除连接',
      danger: true,
      separatorBefore: true,
      onSelect: () => void store.deleteProfile(profile.id),
    });

    onMenu({ x, y, items });
  };

  return (
    <>
      <ConnectionRow
        id={profile.id}
        name={profile.name}
        address={addressOf(profile)}
        status={status}
        selected={state.selectedId === profile.id}
        expanded={expanded}
        onToggleExpand={() => store.toggleExpanded(profile.id)}
        onSelect={() => store.select(profile.id)}
        // 行右侧那个按钮是「新开一个终端」而不是「连接/断开」——
        // 多标签下「断开」是个说不清的操作（断哪一个？），
        // 而「再开一个」永远是明确的。
        //
        // ⚠️ 文案必须一起改：不给的话共享组件按状态显示「断开」，
        // 于是这个**只会新开会话**的按钮写着「断开」—— 用户点了以为是断开，
        // 实际又开出来一个终端。要关会话去会话行右键（下面 `SessionRow`）
        toggleLabels={{ idle: '连接', active: '新开' }}
        toggleTitle="在同一个连接上再开一个终端"
        onToggle={() => {
          store.select(profile.id);
          void store.connect(profile.id);
        }}
        onContextMenu={openMenu}
      />

      {expanded && (
        <div className="rd-db-list" data-testid={`ssh-sessions-${profile.id}`}>
          {sessions.length === 0 && <div className="rd-db-hint">还没有打开的终端</div>}
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={state.activeSessionId === session.id}
              store={store}
              onMenu={onMenu}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SessionRow({
  session,
  active,
  store,
  onMenu,
}: {
  session: SshSession;
  active: boolean;
  store: SshStore;
  onMenu: (menu: OpenMenu) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`rd-db-row rd-ssh-session${active ? ' is-active' : ''}`}
      data-testid={`ssh-session-${session.id}`}
      // 会话 id 是随机生成的，测试没法稳定地写选择器，
      // 所以另外挂两个可预期的属性（和 Redis 给库行挂 data-db 是同一个理由）
      data-session-title={session.title}
      data-session-status={session.status}
      onClick={() => {
        store.select(session.profileId);
        store.setActiveSession(session.id);
      }}
      // 「断开」挂在这儿而不是连接行上：会话行**就是**那一条会话，
      // 点哪条关哪条，不会出现「开了三个，断的是哪个」这种说不清的情况
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            {
              label: '关闭这个会话',
              onSelect: () => void store.closeSession(session.id),
            },
          ],
        });
      }}
      title={sessionEndLabel(session) ?? session.title}
    >
      <span className={`rd-conn-dot is-${dotStatus(session)}`} aria-hidden="true" />
      <span className="rd-db-name">{session.title}</span>
      <span className="rd-db-count">{sessionEndLabel(session) ?? ''}</span>
    </button>
  );
}

/** 侧栏那个小圆点：会话的三种状态映射到共享组件认识的四种 */
function dotStatus(session: SshSession): string {
  switch (session.status) {
    case 'open':
      return 'connected';
    case 'starting':
      return 'connecting';
    default:
      return 'idle';
  }
}

/** 已经结束的会话在名字右边显示结局；还活着的不占位置 */
function sessionEndLabel(session: SshSession): string | null {
  if (session.status !== 'closed') return null;
  return session.exitCode === null ? '已结束' : `退出码 ${session.exitCode}`;
}
