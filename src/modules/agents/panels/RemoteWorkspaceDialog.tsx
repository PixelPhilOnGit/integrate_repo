/**
 * 「加一个远端工作目录」：**两步向导**（用户 2026-10-16 拍板）。
 *
 * 第一步 填连接参数 → 「连上看看」：连上那台机器（主机密钥第一次要确认，
 * 复用会话那套信任语义：**错配硬停、没有「就这样继续」**）。
 * 第二步 在**它报回来的目录列表**里点选（主目录起步、可上一级、可手动输入兜底）
 * —— 不用用户手打路径，这是「交互式的体验好点」的落点。
 *
 * 一个远端工作目录 = **一台机器 + 那台机器上的一个目录**。
 * ⚠️ **密码和私钥口令会进系统钥匙串**（不是本地文件）：工作目录那份存储
 * 走的是 `withSecrets`（见 `state/store.ts` 的 `workspaceStore`），
 * 声明过的就是 `remotePassword` / `remotePassphrase` 两个字段。
 *
 * ⚠️ **一次填一台机器**：同一台机器上开第二个目录要再填一遍认证。
 * 这是有意的取舍 —— 把「机器」抽出来单独管会让用户多学一个概念，
 * 而真慢的是「填密码」这件事本身（一次之后就进钥匙串了）。
 */

import { useRef, useState, type ReactNode } from 'react';
import { useModalKeys } from '../../../shared/ui/useModalKeys';
import type { AgentsStore } from '../state/store';
import type { RemoteAuthKind } from '../core/types';
import { TreeIcon } from '../../../shared/ui/treeGlyphs';
import { agentsServices } from '../services';
import type { RemoteListOutcome, RemoteTargetPayload } from '../services/types';

interface Props {
  store: AgentsStore;
  onClose: () => void;
}

const DEFAULT_PORT = 22;

/** 第二步的目录现场 */
interface DirView {
  path: string;
  parent: string | null;
  dirs: string[];
}

type Trust =
  | null
  | { kind: 'unknown'; algorithm: string; fingerprint: string }
  | { kind: 'mismatch'; expected: string; actual: string };

export function RemoteWorkspaceDialog({ store, onClose }: Props): ReactNode {
  // ---- 第一步：连接参数 ----
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [username, setUsername] = useState('');
  const [authKind, setAuthKind] = useState<RemoteAuthKind>('password');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [name, setName] = useState('');

  // ---- 会话内的信任与目录 ----
  /** 用户在指纹弹层里点过「信任」之后带上的两个字段（只对这次流程有效，不落盘） */
  const [trusted, setTrusted] = useState(false);
  const [trust, setTrust] = useState<Trust>(null);

  const [step, setStep] = useState<'conn' | 'dirs'>('conn');
  const [browsing, setBrowsing] = useState(false);
  const [listing, setListing] = useState<DirView | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** 手输路径兜底（慢线路/不受欢迎的交互时留的门） */
  const [manual, setManual] = useState(false);
  const [manualPath, setManualPath] = useState('');
  /** 最终选定的目录（第二步点「用这个目录」或者手输确认） */
  const [path, setPath] = useState('');

  const portNumber = Number(port);
  const connValid =
    host.trim() !== '' &&
    username.trim() !== '' &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= 65535;

  // ⚠️ `acceptOverride`：点「信任并继续」的那一下要**立刻**带上它重试 ——
  // setTrusted 是异步的，同一帧里再读 `trusted` 还是 false（闭包陈旧值），
  // 假实现/真实现都会再弹一次「未知指纹」（e2e 抓的）
  const payload = (acceptOverride?: boolean): RemoteTargetPayload => ({
    host: host.trim(),
    port: portNumber,
    username: username.trim(),
    authKind,
    password,
    privateKeyPath: privateKeyPath.trim(),
    passphrase,
    // 已经在本机存过指纹的机器由 store 在添加时决定；这里先带上「这次信任过」
    expectedFingerprint: null,
    acceptNewHostKey: acceptOverride ?? trusted,
  });

  /** 连一次、列一个目录（第二步导航也走它） */
  const browse = async (target: string | null, acceptOverride?: boolean): Promise<void> => {
    setBrowsing(true);
    setListError(null);
    try {
      const outcome: RemoteListOutcome = await agentsServices.client.remoteListDirs(
        payload(acceptOverride),
        target,
      );
      switch (outcome.kind) {
        case 'ready':
          setTrust(null);
          setListing({ path: outcome.path, parent: outcome.parent, dirs: outcome.dirs });
          setStep('dirs');
          break;
        case 'hostKeyUnknown':
          setTrust({
            kind: 'unknown',
            algorithm: outcome.algorithm,
            fingerprint: outcome.fingerprint,
          });
          break;
        case 'hostKeyMismatch':
          setTrust({
            kind: 'mismatch',
            expected: outcome.expected,
            actual: outcome.actual,
          });
          break;
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setBrowsing(false);
    }
  };

  const submit = (): void => {
    const finalPath = manual ? manualPath.trim() : path.trim();
    if (finalPath === '') return;
    void store.addRemoteWorkspace({
      host: host.trim(),
      port: portNumber,
      username: username.trim(),
      authKind,
      password,
      privateKeyPath: privateKeyPath.trim(),
      passphrase,
      path: finalPath,
      name: name.trim(),
    });
    onClose();
  };

  // 焦点圈（2026-10-15 体验评审的全仓齐步；主机那个输入框自己带了 autoFocus）
  const modalRef = useRef<HTMLDivElement>(null);
  useModalKeys({ ref: modalRef });

  return (
    <div className="rd-modal-backdrop" data-testid="agent-remote-dialog">
      <div className="rd-modal" ref={modalRef} role="dialog" aria-modal="true">
        <h3>加一个远端工作目录</h3>
        <p className="rd-hint rd-muted">
          会话会跑在<strong>那台机器</strong>上。你这边只是看和打字。
          ⚠️ 远端会话的状态检测弱一些：它靠终端里的通知序列和你的键盘，
          不像本机那样能装钩子（远端写不了我们的脚本）。
        </p>

        {step === 'conn' ? (
          <ConnStep />
        ) : (
          <DirStep />
        )}

        <div className="rd-modal-actions">
          <button type="button" data-testid="remote-cancel" onClick={onClose}>
            取消
          </button>
          {step === 'dirs' && (
            <button
              type="button"
              data-testid="remote-apply"
              disabled={(manual ? manualPath.trim() : path.trim()) === ''}
              onClick={submit}
            >
              添加这个目录
            </button>
          )}
        </div>
      </div>
    </div>
  );

  // ------------------------------------------------------------ 两个步骤

  function ConnStep(): ReactNode {
    return (
      <>
        <label className="rd-field">
          <span>主机</span>
          <input
            data-testid="remote-host"
            value={host}
            autoFocus
            placeholder="10.0.0.9 或 dev.example.com"
            onChange={(e) => setHost(e.target.value)}
          />
        </label>

        <label className="rd-field">
          <span>端口</span>
          <input
            data-testid="remote-port"
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value)}
          />
        </label>

        <label className="rd-field">
          <span>用户名</span>
          <input
            data-testid="remote-username"
            value={username}
            placeholder="root"
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>

        <label className="rd-field">
          <span>认证方式</span>
          <select
            data-testid="remote-auth"
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value === 'key' ? 'key' : 'password')}
          >
            <option value="password">密码</option>
            <option value="key">私钥文件</option>
          </select>
        </label>

        {authKind === 'password' ? (
          <label className="rd-field">
            <span>密码</span>
            <input
              data-testid="remote-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label className="rd-field">
              <span>私钥文件</span>
              <input
                data-testid="remote-key-path"
                value={privateKeyPath}
                placeholder="~/.ssh/id_ed25519"
                onChange={(e) => setPrivateKeyPath(e.target.value)}
              />
            </label>
            <label className="rd-field">
              <span>私钥口令（没有就留空）</span>
              <input
                data-testid="remote-key-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}

        <label className="rd-field">
          <span>显示名（可选）</span>
          <input
            data-testid="remote-name"
            value={name}
            placeholder="留空就用「主机:目录名」"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {trust !== null && trust.kind === 'unknown' && (
          <div className="rd-agent-section" data-testid="remote-trust">
            <p>
              第一次连这台机器。指纹是
              <code className="rd-mono">{` ${trust.algorithm} ${trust.fingerprint} `}</code>
              —— 和你在服务器上跑 <code className="rd-mono">ssh-keygen -lf</code> 对一下。
            </p>
            <button
              type="button"
              className="rd-btn-primary"
              data-testid="remote-trust-accept"
              onClick={() => {
                setTrusted(true);
                void browse(null, true);
              }}
            >
              指纹没问题，继续
            </button>
          </div>
        )}

        {trust !== null && trust.kind === 'mismatch' && (
          <div className="rd-agent-section" data-testid="remote-trust-mismatch">
            <p className="rd-danger">
              ⚠️ 这台机器的指纹和记录里的**不一样**：记录的是{' '}
              <code className="rd-mono">{trust.expected}</code>，现在报的是{' '}
              <code className="rd-mono">{trust.actual}</code>。
              这可能意味着有人在中间拦截。**先去服务器上查清楚**，这里没有「就这样继续」。
            </p>
          </div>
        )}

        {listError !== null && (
          <p className="rd-danger" data-testid="remote-error">
            {listError}
          </p>
        )}

        <div className="rd-modal-actions">
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="remote-connect"
            disabled={!connValid || browsing}
            onClick={() => void browse(null)}
          >
            {browsing ? '正在连…' : '连上看看'}
          </button>
        </div>
      </>
    );
  }

  function DirStep(): ReactNode {
    if (manual) {
      return (
        <>
          <label className="rd-field">
            <span>直接输入路径</span>
            <input
              data-testid="remote-path-manual"
              value={manualPath}
              autoFocus
              placeholder="/srv/app"
              onChange={(e) => setManualPath(e.target.value)}
            />
          </label>
          <button type="button" className="rd-btn" data-testid="remote-browse-toggle" onClick={() => setManual(false)}>
            回到目录浏览
          </button>
        </>
      );
    }
    const view = listing;
    return (
      <>
        <div className="rd-remote-path" data-testid="remote-current-path">
          <button
            type="button"
            className="rd-btn"
            data-testid="remote-up"
            disabled={view === null || view.parent === null}
            title="上一级"
            onClick={() => {
              if (view?.parent != null) void browse(view.parent);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="rd-btn"
            data-testid="remote-home"
            title="主目录"
            onClick={() => void browse(null)}
          >
            主目录
          </button>
          <code className="rd-mono" title={view?.path ?? ''}>
            {view?.path ?? ''}
          </code>
        </div>

        <ul className="rd-remote-dirs" data-testid="remote-dirs">
          {(view?.dirs ?? []).map((d) => {
            const child = view === null ? d : `${view.path === '/' ? '' : view.path}/${d}`;
            return (
              <li key={d}>
                <button
                  type="button"
                  className="rd-remote-dir"
                  data-testid={`remote-dir-${d}`}
                  onClick={() => void browse(child)}
                >
                  <TreeIcon kind="dir" open={false} /> {d}
                </button>
                <button
                  type="button"
                  className="rd-btn"
                  data-testid={`remote-use-${d}`}
                  title="就用这个子目录（不进去）"
                  onClick={() => setPath(child)}
                >
                  选它
                </button>
              </li>
            );
          })}
          {view !== null && view.dirs.length === 0 && (
            <li className="rd-muted">（这个目录里没有子目录）</li>
          )}
        </ul>

        {listError !== null && (
          <p className="rd-danger" data-testid="remote-error">
            {listError}
          </p>
        )}

        <div className="rd-remote-pick">
          <button
            type="button"
            className="rd-btn-primary"
            data-testid="remote-use-current"
            onClick={() => view !== null && setPath(view.path)}
          >
            正在看的这个：用这里
          </button>
          <span className="rd-muted" data-testid="remote-picked">
            {path === '' ? '还没有选' : `已选：${path}`}
          </span>
          <button type="button" className="rd-btn" data-testid="remote-manual-toggle" onClick={() => setManual(true)}>
            手动输入路径
          </button>
        </div>
      </>
    );
  }
}
