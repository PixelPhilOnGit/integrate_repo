/**
 * 「这台机器上没有系统钥匙串」的一个小提醒（悬浮才展开文字）。
 *
 * # 为什么必须有它
 *
 * 密码走系统钥匙串是**尽力而为**的：服务器、headless 容器、没起桌面会话的 Linux
 * 上都拿不到钥匙串，那时候密码只能跟档案一起存在本地文件里（老行为）。
 * 这条路**允许存在**（否则那些机器上应用直接不能用），但**不能是静默的** ——
 * 用户以为密码已经进钥匙串了，实际上还在明文文件里，那是安全上的意外，
 * 不只是洁癖。
 *
 * # 只在桌面端显示
 *
 * 浏览器版**本来就没有钥匙串**（`secrets.ts` 的 web 实现恒为不可用），
 * 在那里常年挂一个警告是纯噪音 —— 用户也没法为它做任何事。
 * 所以这一层用 `isTauri()` 挡住，**e2e 里不会出现**。
 *
 * 探测是异步的（一次 IPC），所以默认不显示，探到了才出现 —— 反过来做的话
 * 会在桌面端闪一下再消失。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '../platform/detect';
import { createSecrets } from '../platform/secrets';

export function KeychainNotice(): ReactNode {
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    void createSecrets()
      .available()
      .then((ok) => {
        if (alive) setMissing(!ok);
      })
      .catch(() => {
        // 探测本身失败就当没有 —— 这时候报「钥匙串有问题」反而误导
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!missing) return null;

  return (
    <span
      className="rd-keychain-warn"
      data-testid="keychain-missing"
      title={
        '这台机器上拿不到系统钥匙串（没有桌面会话、或者凭据服务没起来）。\n' +
        '所以连接密码**仍然存在本地文件里**，而不是系统凭据库。\n' +
        '在共享的机器上别填生产环境的密码。'
      }
    >
      ⚠
    </span>
  );
}
