/**
 * 已知主机（TOFU 的信任记录）。纯函数，不碰平台也不碰 store。
 *
 * # 为什么键是 host + port 而不是 host
 *
 * 同一台机器在 22 和 2222 上是**两个不同的信任对象**。只按 host 存的话，
 * 「A 机器的 2222 端口」和「A 机器的 22 端口」会互相冒充 —— 攻击者只要能让你
 * 连一次他那台跑在某个非常规端口上的机器，就能把 22 端口的记录覆盖掉，
 * 以后你真连 22 时反而显示成「密钥变了」或者干脆被信任。
 *
 * 这和 OpenSSH 的 `known_hosts` 行为一致（非默认端口会写成 `[host]:port`）。
 *
 * # 为什么信任状态放在前端
 *
 * 和「连接档案归前端持有、Rust 只存活连接」是同一条分工：指纹是**用户的决定**，
 * 属于配置，归前端持久化；而「这次握手看到的密钥可不可信」这个判定必须在
 * 握手现场做，归 Rust。两边各管各的，不存在漂移。
 */

import { asArray, asPort, asRecord, asString } from '../../../shared/connections/profiles';
import type { KnownHost } from './types';

/**
 * 把主机名规范化。
 *
 * 三件事，都有理由：
 * - **去空白**：用户填的地址前后带空格是常事
 * - **转小写**：DNS 名字大小写不敏感，`Example.COM` 和 `example.com` 是同一台。
 *   IP 字面量不受影响（v6 的十六进制本来也大小写不敏感）
 * - **去掉 IPv6 的方括号**：地址栏里写 `[::1]:22` 是惯例，但存下来的是 `::1`。
 *   不统一的话，「填 `[::1]` 的人」和「填 `::1` 的人」会拿到两份互不相认的记录
 */
export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 给 React 的 key 和 testid 用。不能用 host:port 原样拼 —— 里面有冒号 */
export function knownHostId(host: string, port: number): string {
  return `${normalizeHost(host)}_${port}`;
}

/** 找一条记录。没存过返回 null */
export function findKnownHost(
  hosts: readonly KnownHost[],
  host: string,
  port: number,
): KnownHost | null {
  const target = normalizeHost(host);
  return hosts.find((h) => normalizeHost(h.host) === target && h.port === port) ?? null;
}

/**
 * 记下一条信任。已经有的就**替换**（指纹变了之后用户手动解信任再重连时会走到）。
 */
export function rememberKnownHost(
  hosts: readonly KnownHost[],
  entry: KnownHost,
  now: string,
): KnownHost[] {
  const target = normalizeHost(entry.host);
  const next = hosts.filter(
    (h) => !(normalizeHost(h.host) === target && h.port === entry.port),
  );
  next.push({ ...entry, host: target, addedAt: now });
  return next;
}

/** 忘掉一台机器。「密钥变了」之后用户确认服务器确实重装过就走这条 */
export function forgetKnownHost(
  hosts: readonly KnownHost[],
  host: string,
  port: number,
): KnownHost[] {
  const target = normalizeHost(host);
  return hosts.filter((h) => !(normalizeHost(h.host) === target && h.port === port));
}

/**
 * 把存储里读出来的**不可信数据**整形成 `KnownHost[]`。
 *
 * 和连接档案一样的策略：逐条校验、丢掉不合法的、缺字段补默认值 ——
 * 目标是「尽力恢复」而不是「严格拒绝」。一条坏记录不该让所有信任记录消失
 * （那会让用户连每一台机器都被问一遍，很快他就会习惯性点「信任」，
 * 而那正是这道防线失效的方式）。
 *
 * ⚠️ **指纹为空的记录必须丢掉**。留着它等于留了一条「不用比对就一定通过」
 * 的记录 —— 判定逻辑里空指纹永远匹配不上，但它会占住 host:port 这个键，
 * 让用户以为这台机器已经信任过了。
 */
export function sanitizeKnownHosts(raw: unknown): KnownHost[] {
  const out: KnownHost[] = [];

  for (const item of asArray(raw)) {
    const record = asRecord(item);
    if (!record) continue;

    const host = normalizeHost(asString(record['host']));
    // 指纹要 trim 之后再判空：手工编辑过的配置里很容易留下一个只有空格的值，
    // 而它**看起来像条记录**、却永远匹配不上任何真实的指纹
    const fingerprint = asString(record['fingerprint']).trim();
    if (host === '' || fingerprint === '') continue;

    out.push({
      host,
      port: asPort(record['port'], 22),
      algorithm: asString(record['algorithm']),
      fingerprint,
      addedAt: asString(record['addedAt']),
    });
  }

  return out;
}

/** 给「已信任的主机」那类展示用的排序：按主机名再按端口 */
export function sortKnownHosts(hosts: readonly KnownHost[]): KnownHost[] {
  return [...hosts].sort((a, b) => {
    const byHost = a.host.localeCompare(b.host);
    return byHost !== 0 ? byHost : a.port - b.port;
  });
}

/** 存储里用的键名。和 `services/index.ts` 里的 kv 文件配套 */
export const KNOWN_HOSTS_KEY = 'knownHosts';

/** 兜底：某些老记录没有 addedAt，展示时不该显示成空 */
export function addedAtOf(entry: KnownHost): string {
  return entry.addedAt === '' ? '（记录时间未知）' : entry.addedAt;
}
