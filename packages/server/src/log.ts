/**
 * 日志的最小契约。
 *
 * store / probe / runners 这些模块不该知道「日志是 pino 还是别的什么」，
 * 也不该把 fastify 的类型拖进自己的依赖面——它们只接收一个函数（或一组函数）。
 * 由 `app.ts` 负责把 fastify 的 pino 实例适配成这里的形状。
 */

/** 一条日志：消息 + 可选结构化细节。 */
export type LogFn = (message: string, detail?: unknown) => void;

/**
 * 三档级别的精简日志面。
 *
 * 只留实际用到的三档：debug 用于可回放的细节（Agent 输出、探测摘要），
 * warn 用于「还能继续跑但值得看一眼」（子进程登记失败），
 * error 用于「这一轮已经失败」（推进异常）。
 */
export interface LogSink {
  debug: LogFn;
  warn: LogFn;
  error: LogFn;
}

const noop: LogFn = () => {};

/** 未注入日志时的默认实现：调用点是干净的，不必到处写 `?.`。 */
export const silentLog: LogSink = { debug: noop, warn: noop, error: noop };
