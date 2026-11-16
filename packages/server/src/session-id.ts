/**
 * 确定性会话 id 派生（RFC 4122 版本 5）。
 *
 * 为什么需要它：`session.derive: 'uuidv5'` 的平台（Claude Code、Qoder）允许
 * 调用方自己指定会话 id。给定固定输入算出固定 id，就意味着编排器重启、
 * 事件日志重放、甚至换一台机器，只要 (runId, nodeId) 相同，算出来的会话 id
 * 就相同，于是上一轮 Agent 留下的上下文还能接上。这是「重启后还能续跑」
 * 唯一可靠的前提——靠捕获原生 id 的 hooked 派做不到这一点。
 *
 * 必须放在 server 而不是 core：core 要能被前端打包，不能引入 node:crypto。
 */

import { createHash } from 'node:crypto';

/**
 * 命名空间 UUID。
 *
 * 它唯一的作用是把「本编排器的会话 id 空间」与别人区分开：同一对
 * (runId, nodeId) 在另一个命名空间下会派生出完全不同的 id，因此不同
 * 部署 / 不同实例的会话 id 不会互相撞车（Claude 那边是按 id 找会话的，
 * 撞了就等于读到别人的上下文）。**换掉它等于换命名空间**：已经跑过的
 * 节点会因为算不出旧 id 而全部退化为新跑。
 */
export const SESSION_NAMESPACE = 'c2f5b8e4-1a7d-5b93-9e02-6d4c8a1f3b57';

/** 解析 32 位十六进制 UUID 为 16 字节。格式不对直接抛，让启动期就暴露配置错误。 */
function namespaceBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`命名空间不是合法 UUID：${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * 按 RFC 4122 §4.3 实现 v5：SHA-1(命名空间字节 + 名字)，取前 16 字节，
 * 再把版本位与变体位改写。
 *
 * 名字用 `${runId 长度}:${runId}/${nodeId}` 而不是裸拼接：`runId` 里一旦
 * 带分隔符，`a/b`+`c` 与 `a`+`b/c` 会拼成同一个字符串，两个不同的节点
 * 于是拿到同一个会话 id——那等于让一个节点读到另一个节点的上下文。
 * 长度前缀把「名字段」变成前缀无关的编码，歧义就此消失。
 */
export function createSessionIdDeriver(
  namespace: string,
): (runId: string, nodeId: string) => string {
  const ns = namespaceBytes(namespace);

  return (runId: string, nodeId: string): string => {
    const digest = createHash('sha1')
      .update(ns)
      .update(`${runId.length}:${runId}/${nodeId}`, 'utf8')
      .digest();

    const bytes = Buffer.from(digest.subarray(0, 16));
    // 版本位：高 4 位写 5
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
    // 变体位：高 2 位写 10（即首字符落在 8/9/a/b）
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    const hex = bytes.toString('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  };
}
