/**
 * 左侧栏：目录 → 连接 的树。**连接就是叶子**。
 *
 * ⚠️ 会话**不在侧栏**（2026-10-15 用户定的：原来展开连接会列出它的终端标签，
 * 原话「ssh 链接下面会话不需要在左侧展示，也就是连接就是叶子节点了，会话不需要
 * 有」）。会话只归主区顶上的标签栏 —— 那里本来就有（点哪条切哪条、每条带关闭
 * 按钮），侧栏再挂一份是两处重复。侧栏搜索**仍然匹配会话标题**：拿一个标签名
 * 来搜，落回它所属的连接（那是唯一有意义的落点）；但没有「自动展开看会话」
 * 这回事了 —— 没有可展开的东西。
 *
 * # 目录**可以嵌套**（2026-10-14 起），界面叫「目录」、内部叫 group
 *
 * 树逻辑（建树、路径、防环）全在 `shared/connections/groups.ts`；拖拽（抓手起拖、
 * 目录/空白落下）在 `shared/connections/useConnectionDrag.ts`。这里只负责画。
 * 每个目录节里**连接在前、子目录在后**（同「未分组画最上面」的理：新建的东西
 * 要显眼）。
 */

import { useState, type ReactNode } from 'react';
import { ConnectionGroupRow } from '../../../shared/connections/ConnectionGroupRow';
import {
  buildTree,
  descendantIds,
  groupPath,
  subtreeCount,
  type TreeNode,
} from '../../../shared/connections/groups';
import { ConnectionRow } from '../../../shared/connections/ConnectionRow';
import { KeychainNotice } from '../../../shared/connections/KeychainNotice';
import type { ConnectionGroup } from '../../../shared/connections/types';
import {
  ROOT_TARGET,
  useConnectionDrag,
  type ConnectionDrag,
} from '../../../shared/connections/useConnectionDrag';
import { NoMatch, SearchBox } from '../../../shared/ui/SearchBox';
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu';
import { fuzzyBest } from '../../../shared/search';
import { addressOf } from '../core/profile';
import type { SshProfile } from '../core/types';
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
  /** 哪些目录是收起来的。**纯显示状态，不持久化** */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  /** 正在行内改名的目录 id + 草稿（和文件树那套一样，不用弹窗） */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /**
   * 「新建连接」弹框开着没有。开了才挂载，所以每次都是干净草稿。
   * 带着预选目录 —— 「在此新建连接」和顶部「新建」都走这一条路。
   */
  const [newOpen, setNewOpen] = useState<{ groupId: string | null } | null>(null);

  const q = query.trim();
  const searching = q !== '';

  // 匹配的是**连接自己**（名字/地址）或者它的**会话标题**。
  // 会话命中时那条连接要留下 —— 否则用户拿一个标签名来搜会得到「没有匹配的」，
  // 而连接是那个标题唯一有意义的落点（会话只住在主区标签栏里）。
  //
  // ⚠️ 保序（`filter` 而不是按分排序）：这里是一棵树，顺序就是用户摆出来的
  // 形状；边打字边重排会让人找不到刚才那一条。平铺的列表（Redis / SQL 的连接）
  // 才按相关度排。
  const visible = state.profiles.filter((profile) => {
    if (!searching) return true;
    if (fuzzyBest(q, [profile.name, addressOf(profile)]) !== null) return true;
    return store.sessionsOf(profile.id).some((s) => fuzzyBest(q, [s.title]) !== null);
  });

  // ⚠️ 搜索时才藏空目录：**平时空目录必须画出来**，用户刚点「＋目录」建的就是
  // 空目录，藏起来他会以为按钮坏了（见 `buildTree` 的说明）。搜索时是**递归**藏：
  // 子树里一条命中都没有的目录才不见
  const grouped = buildTree(visible, state.groups, searching);

  const drag = useConnectionDrag({
    groups: state.groups,
    moveProfile: (id, groupId) => void store.moveToGroup(id, groupId),
    moveGroup: (id, parentId) => void store.moveGroup(id, parentId),
  });

  /**
   * 搜索时**强制展开**所有目录 —— 命中的那条埋在收起来的目录里等于没搜到。
   *
   * ⚠️ 撑开是**临时的**（叠加在这一步），`collapsedGroups` 一个字不写：写进去的话，
   * 清空搜索之后被搜索撑开的目录会自己开着，用户手动收起来的那层就回不去了。
   * 文件树那边踩过同一个坑，规矩是一样的。
   */
  const isGroupCollapsed = (id: string): boolean => !searching && collapsedGroups[id] === true;
  const toggleGroup = (id: string): void =>
    setCollapsedGroups((c) => ({ ...c, [id]: !isGroupCollapsed(id) }));

  /** 把某个目录撑开（新建子目录/在此新建连接之后，得让用户看得见成果） */
  const expandGroup = (id: string): void =>
    setCollapsedGroups((c) => ({ ...c, [id]: false }));

  const commitRename = async (): Promise<void> => {
    const id = renaming;
    setRenaming(null);
    if (id === null || draft.trim() === '') return;
    await store.renameGroup(id, draft.trim());
  };

  /**
   * 目录的右键菜单。
   *
   * 「移入」列的是**别的**目录（全路径 —— 嵌套之后同名目录光看名字分不清）：
   * 不能是自己或自己的子树（那是环，`moveGroupIn` 也会再拦一道）。
   * 删除是**数据丢失级别**的操作，文案说清楚；确认弹窗在 store 里（取消则
   * 一个字不写盘），这里只负责把后果写进菜单。
   */
  const openGroupMenu = (group: ConnectionGroup, x: number, y: number): void => {
    const items: MenuItem[] = [
      {
        label: '在此新建连接',
        onSelect: () => {
          expandGroup(group.id);
          setNewOpen({ groupId: group.id });
        },
      },
      {
        label: '新建子目录',
        onSelect: () => {
          expandGroup(group.id); // 建完得看得见（父目录正收着的话）
          void store.createGroup(group.id);
        },
      },
      {
        label: '重命名',
        onSelect: () => {
          setRenaming(group.id);
          setDraft(group.name);
        },
      },
    ];

    const inside = descendantIds(state.groups, group.id);
    const movables = state.groups.filter((g) => g.id !== group.id && !inside.has(g.id));
    if (movables.length > 0) {
      items.push(
        ...movables.map((g, i) => ({
          label: `移入「${groupPath(state.groups, g.id)}」`,
          separatorBefore: i === 0,
          onSelect: () => void store.moveGroup(group.id, g.id),
        })),
      );
    }
    if (group.parentId !== undefined) {
      items.push({
        label: '移出到顶层',
        onSelect: () => void store.moveGroup(group.id, null),
      });
    }

    items.push({
      // 把后果写在菜单里，比事后再弹一个确认框强 —— 用户点之前就该知道
      label: '删除目录（连同里面的东西）',
      danger: true,
      separatorBefore: true,
      onSelect: () => void store.deleteGroup(group.id),
    });

    setMenu({ x, y, items });
  };

  /** 目录头（或者它被改名时的输入框） */
  const renderGroupHead = (group: ConnectionGroup, count: number): ReactNode => {
    if (renaming === group.id) {
      return (
        <div className="rd-conn-group-head" data-testid={`conn-group-rename-${group.id}`}>
          <span className="rd-agent-caret" />
          <input
            className="rd-rename-input"
            autoFocus
            value={draft}
            aria-label="重命名目录"
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
        path={groupPath(state.groups, group.id)}
        collapsed={isGroupCollapsed(group.id)}
        onToggle={() => toggleGroup(group.id)}
        onContextMenu={(x, y) => openGroupMenu(group, x, y)}
        dragHandle={drag.handleProps({ kind: 'group', id: group.id })}
        dragging={drag.dragging?.kind === 'group' && drag.dragging.id === group.id}
        dropTarget={drag.dropTargetId === group.id}
      />
    );
  };

  /**
   * 一个目录节（头 + 展开的成员），**递归**。
   *
   * 缩进不加新规则：每层再包一个 `.rd-conn-group-body`（padding-left 8px），
   * 嵌套自动累加。
   *
   * 拖拽的落点挂在**整节**上（头 + 身子都算）—— 落点大一点好拖；里面的子节
   * 会先接住并 `stopPropagation`，不会串层。
   */
  const renderGroupNode = (node: TreeNode<SshProfile>): ReactNode => {
    const collapsed = isGroupCollapsed(node.group.id);
    return (
      <div key={node.group.id} {...drag.zoneProps(node.group.id)}>
        {renderGroupHead(node.group, subtreeCount(node))}
        {!collapsed && (
          <div className="rd-conn-group-body">
            {node.items.map((profile) => (
              <ConnectionBranch
                key={profile.id}
                profile={profile}
                state={state}
                store={store}
                onMenu={setMenu}
                drag={drag}
              />
            ))}
            {node.children.map(renderGroupNode)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="rd-panel rd-conn-list" data-testid="ssh-conn-list">
      <div className="rd-panel-head">
        <span>连接</span>
        {/* 钥匙串用不了时提醒一句（桌面端才有；见 KeychainNotice） */}
        <KeychainNotice />
        <button
          type="button"
          data-testid="ssh-btn-new-group"
          title="新建目录（把连接归归类，目录里还能再建目录）"
          onClick={() => void store.createGroup()}
        >
          ＋目录
        </button>
        <button
          type="button"
          // 2026-10-15 体验评审：主行动钉最右端（redis/sql 都是这个顺序，
          // ssh 原来是「新建｜＋目录」反的 —— 切换模块时手会点错），
          // 顺带补上和 redis/sql 一样的 title
          title="新建连接"
          data-testid="ssh-btn-new"
          onClick={() => setNewOpen({ groupId: null })}
        >
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

      {/* ⚠️ **有目录就先画树**（哪怕一条连接都没有）：「先建目录 → 在目录下建
          连接」是一条正经路径（目录右键「在此新建连接」），没有连接就把树藏了的话，
          用户建完目录会以为按钮坏了 —— 和「空目录照画」是同一个教训 */}
      {state.profiles.length === 0 && state.groups.length === 0 ? (
        <div className="rd-empty">还没有连接，点「新建」加一个</div>
      ) : searching && visible.length === 0 ? (
        // ⚠️ `searching &&` 不能省：有目录、一条连接都没有时 visible 也是空的，
        // 少了这个前提会把整棵树误落到「没有匹配」那一支
        <NoMatch testId="ssh-conn-nomatch" />
      ) : (
        // 面板空白是「拖回顶层/未分组」的落点（拖拽时整块描边）
        <div
          className={`rd-panel-body${
            drag.dropTargetId === ROOT_TARGET ? ' is-drop-root' : ''
          }`}
          {...drag.zoneProps(null)}
        >
          {/* 未分组的在最上面（也不缩进）：新建的连接就在这儿 */}
          {grouped.ungrouped.map((profile) => (
            <ConnectionBranch
              key={profile.id}
              profile={profile}
              state={state}
              store={store}
              onMenu={setMenu}
              drag={drag}
            />
          ))}

          {grouped.roots.map(renderGroupNode)}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {newOpen !== null && (
        <NewConnectionDialog
          state={state}
          store={store}
          defaultGroupId={newOpen.groupId}
          onClose={() => setNewOpen(null)}
        />
      )}
    </div>
  );
}

function ConnectionBranch({
  profile,
  state,
  store,
  onMenu,
  drag,
}: {
  profile: SshProfile;
  state: SshState;
  store: SshStore;
  onMenu: (menu: OpenMenu) => void;
  drag: ConnectionDrag;
}): ReactNode {
  // ⚠️ 状态是**从会话列表推出来的**，不另存一份 —— 见 store 里 `statusOf` 的注释
  const status = store.statusOf(profile.id);
  const allSessions = store.sessionsOf(profile.id);
  const known = store.hostKeyFor(profile);

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

    // 「移入目录」：`ContextMenu` 没有子菜单，所以平铺列出来，**用全路径** ——
    // 嵌套之后两个「项目A」光看名字分不清。当前的目录会打勾，一眼看出在哪儿
    if (state.groups.length > 0) {
      items.push(
        ...state.groups.map((group, i) => ({
          label: `移入「${groupPath(state.groups, group.id)}」`,
          checked: profile.groupId === group.id,
          separatorBefore: i === 0,
          onSelect: () => void store.moveToGroup(profile.id, group.id),
        })),
      );
    }
    if (profile.groupId !== undefined) {
      items.push({
        label: '移出到未分组',
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

  // ⚠️ **这一行就是叶子**：不给 `expanded`/`onToggleExpand`，连折叠箭头都不画
  // （会话只住在主区标签栏里，见文件头）。
  return (
    <ConnectionRow
      id={profile.id}
      name={profile.name}
      address={addressOf(profile)}
      status={status}
      selected={state.selectedId === profile.id}
      onSelect={() => store.select(profile.id)}
      // 行右侧那个按钮是「新开一个终端」而不是「连接/断开」——
      // 多标签下「断开」是个说不清的操作（断哪一个？），
      // 而「再开一个」永远是明确的。
      //
      // ⚠️ 文案必须一起改：不给的话共享组件按状态显示「断开」，
      // 于是这个**只会新开会话**的按钮写着「断开」—— 用户点了以为是断开，
      // 实际又开出来一个终端。
      toggleLabels={{ idle: '连接', active: '新开' }}
      toggleTitle="在同一个连接上再开一个终端"
      onToggle={() => {
        store.select(profile.id);
        void store.connect(profile.id);
      }}
      onContextMenu={openMenu}
      dragHandle={drag.handleProps({ kind: 'profile', id: profile.id })}
      dragging={drag.dragging?.kind === 'profile' && drag.dragging.id === profile.id}
    />
  );
}
