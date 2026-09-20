/**
 * 「加一个远端工作目录」的表单。
 *
 * 一个远端工作目录 = **一台机器 + 那台机器上的一个目录**。
 * 会话在那边跑，我们这边只是看和打字（SSH）。
 *
 * ⚠️ **密码和私钥口令会进系统钥匙串**（不是本地文件）：工作目录那份存储
 * 走的是 `withSecrets`（见 `state/store.ts` 的 `workspaceStore`），
 * 声明过的就是 `remotePassword` / `remotePassphrase` 两个字段。
 *
 * ⚠️ **一次填一台机器**：同一台机器上开第二个目录要再填一遍认证。
 * 这是有意的取舍 —— 把「机器」抽出来单独管会让用户多学一个概念，
 * 而真慢的是「填密码」这件事本身（一次之后就进钥匙串了，重填只是省了复制粘贴）。
 */

import { useState, type ReactNode } from 'react';
import type { AgentsStore } from '../state/store';
import type { RemoteAuthKind } from '../core/types';

interface Props {
  store: AgentsStore;
  onClose: () => void;
}

const DEFAULT_PORT = 22;

export function RemoteWorkspaceDialog({ store, onClose }: Props): ReactNode {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [username, setUsername] = useState('');
  const [authKind, setAuthKind] = useState<RemoteAuthKind>('password');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');

  const portNumber = Number(port);
  const valid =
    host.trim() !== '' &&
    username.trim() !== '' &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= 65535 &&
    path.trim() !== '';

  const submit = (): void => {
    if (!valid) return;
    void store.addRemoteWorkspace({
      host: host.trim(),
      port: portNumber,
      username: username.trim(),
      authKind,
      password,
      privateKeyPath: privateKeyPath.trim(),
      passphrase,
      path: path.trim(),
      name: name.trim(),
    });
    onClose();
  };

  return (
    <div className="rd-modal-backdrop" data-testid="agent-remote-dialog">
      <div className="rd-modal" role="dialog" aria-modal="true">
        <h3>加一个远端工作目录</h3>
        <p className="rd-hint rd-muted">
          会话会跑在**那台机器**上。你这边只是看和打字。
          ⚠️ 远端会话的状态检测弱一些：它靠终端里的通知序列和你的键盘，
          不像本机那样能装钩子（远端写不了我们的脚本）。
        </p>

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
              <span>私钥文件（**本机**的路径）</span>
              <input
                data-testid="remote-key"
                value={privateKeyPath}
                placeholder="~/.ssh/id_ed25519"
                onChange={(e) => setPrivateKeyPath(e.target.value)}
              />
            </label>
            <label className="rd-field">
              <span>私钥口令（没有就留空）</span>
              <input
                data-testid="remote-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}

        <label className="rd-field">
          <span>那台机器上的目录</span>
          <input
            data-testid="remote-path"
            value={path}
            placeholder="/home/me/project"
            onChange={(e) => setPath(e.target.value)}
          />
        </label>

        <label className="rd-field">
          <span>显示名（留空就用目录名）</span>
          <input
            data-testid="remote-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="rd-modal-actions">
          <button type="button" className="rd-btn" data-testid="remote-cancel" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="rd-btn rd-btn-primary"
            data-testid="remote-confirm"
            disabled={!valid}
            onClick={submit}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
