/**
 * 键格式：`runId\0nodeId`。
 *
 * 两个执行器（进程树那一路与 SDK 那一路）各自维护一张内存表，取消时都靠
 * 「键前缀是不是这个 run」来筛目标。格式只要有一处不一致，取消就会静默落空
 * ——进程还在烧 token，界面却显示已停止。所以这个格式单独放一处共用，
 * 不让两份实现各写一遍字符串拼接。
 *
 * 用 NUL 分隔而不是 `:` 或 `-`：run id 与 node id 都可能含分隔符，
 * 而 `run-1` 不能误配 `run-10`。
 */
export function activeKey(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`;
}

/** 这个键是不是属于给定 run。取消永远按运行隔离，绝不跨 run 误杀。 */
export function belongsToRun(key: string, runId: string): boolean {
  return key.startsWith(`${runId}\u0000`);
}
