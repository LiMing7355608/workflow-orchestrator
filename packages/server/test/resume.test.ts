import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunRequest } from '@orchestrator/core';
import { DshSdkRunner } from '../src/runners/dsh-sdk.js';
import { ClaudeSdkRunner } from '../src/runners/claude-sdk.js';
import { planSessionOpening } from '../src/runners/acp.js';
import type { LogSink } from '../src/log.js';

/**
 * 三个「走 SDK / 走协议」的执行器的续跑分支。
 *
 * 为什么用假的 SDK 而不是真起进程：这里要断言的是**决策**——这一轮到底调了
 * `resumeSession` / `session/resume` / `options.resume`，还是走了新建；以及
 * 退回新建时回传的会话 id 是哪一个。这些都在「SDK 被怎么调用」这一层就定了，
 * 真起进程只会把网络与凭证拖进测试。
 *
 * ACP 那条路的「起进程 + 发协议请求」没法这样注入，所以它的判定被抽成了纯函数
 * `planSessionOpening`（源码真正走的就是它），在这里直接验三个分支。
 */

/** 探测可执行文件会碰本机 PATH，测试里一律当作「找不到」。 */
vi.mock('../src/probe.js', () => ({
  resolveExecutable: () => Promise.resolve(undefined),
}));

/* ------------------------------------------------------------------ *
 * 日志：把 warn / debug 收集起来，用来断言「退回新建有没有留痕」
 * ------------------------------------------------------------------ */

interface LogRecord {
  message: string;
  detail?: unknown;
}

interface RecordingLog extends LogSink {
  warns: LogRecord[];
  debugs: LogRecord[];
}

function recordingLog(): RecordingLog {
  const warns: LogRecord[] = [];
  const debugs: LogRecord[] = [];
  return {
    warns,
    debugs,
    debug: (message, detail) => {
      debugs.push({ message, detail });
    },
    warn: (message, detail) => {
      warns.push({ message, detail });
    },
    error: () => {},
  };
}

function baseRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: 'run-resume',
    nodeId: 'n1',
    agentId: 'probe-agent',
    bin: 'probe-agent',
    argv: ['probe-agent'],
    stdin: '只回复 OK',
    cwd: '.',
    timeoutMs: 5_000,
    policy: 'default',
    ...overrides,
  };
}

/**
 * 从 onChunk 收到的行里挑出各平台自己的「会话行」。
 *
 * 三种形状都要认：dsh 与 ACP 是 `dsh-json` 的 `{"type":"session",…}`，
 * claude 是 CLI stream-json 的 `{"type":"system","subtype":"init",…}`。
 */
function sessionLineIds(chunks: string[]): string[] {
  const ids: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { type?: unknown; session_id?: unknown };
        const carriesSession = parsed.type === 'session' || parsed.type === 'system';
        if (carriesSession && typeof parsed.session_id === 'string') {
          ids.push(parsed.session_id);
        }
      } catch {
        // 不是 JSON 的行与这件事无关
      }
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ *
 * dsh SDK
 * ------------------------------------------------------------------ */

class FakeDshSession {
  constructor(
    private readonly harness: FakeDshHarness,
    readonly id: string,
  ) {}

  async run(input: string): Promise<unknown> {
    this.harness.runs.push(input);
    return { finishReason: 'completed', finalResponse: `回答:${input}`, events: [] };
  }
}

class FakeDshHarness {
  static instances: FakeDshHarness[] = [];
  /** 非空表示下一次 resumeSession 会以这个错误失败（模拟会话被清理）。 */
  static resumeError: Error | undefined;

  readonly resumeCalls: string[] = [];
  readonly sessionCalls: (string | undefined)[] = [];
  readonly runs: string[] = [];
  readonly options: unknown;
  closeCalls = 0;

  constructor(options: unknown) {
    this.options = options;
    FakeDshHarness.instances.push(this);
  }

  session(sessionId?: string): FakeDshSession {
    this.sessionCalls.push(sessionId);
    return new FakeDshSession(this, sessionId ?? 'session-fresh');
  }

  async resumeSession(sessionId: string): Promise<FakeDshSession> {
    this.resumeCalls.push(sessionId);
    const failure = FakeDshHarness.resumeError;
    if (failure) {
      throw failure;
    }
    return new FakeDshSession(this, sessionId);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function dshRunner(log: LogSink): DshSdkRunner {
  const runner = new DshSdkRunner(log);
  // 白盒注入：`sdkModule` 是私有字段，但它的语义就是「已经加载好的 SDK」，
  // 提前填上等于跳过动态 import，不改变被测逻辑。
  (runner as unknown as { sdkModule: Promise<unknown> }).sdkModule = Promise.resolve({
    DeepSeekHarness: FakeDshHarness,
  });
  return runner;
}

describe('dsh SDK 的续跑分支', () => {
  beforeEach(() => {
    FakeDshHarness.instances = [];
    FakeDshHarness.resumeError = undefined;
  });

  it('有 sessionId 时调 resumeSession，并把同一个 id 回传', async () => {
    const log = recordingLog();
    const chunks: string[] = [];
    const result = await dshRunner(log).run(
      baseRequest({ sessionId: 'session-existing' }),
      (chunk) => chunks.push(chunk),
    );

    expect(FakeDshHarness.instances).toHaveLength(1);
    const harness = FakeDshHarness.instances[0]!;
    expect(harness.resumeCalls).toEqual(['session-existing']);
    // 没有顺手再开一个新会话
    expect(harness.sessionCalls).toEqual([]);
    expect(result.ok).toBe(true);
    // 回传的必须是**上游传进来**的那个 id，不是新建出来的
    expect(sessionLineIds(chunks)).toEqual(['session-existing']);
    expect(log.warns).toEqual([]);
  });

  it('没有 sessionId 时开新会话，从不碰 resumeSession', async () => {
    const log = recordingLog();
    const chunks: string[] = [];
    const result = await dshRunner(log).run(baseRequest(), (chunk) => chunks.push(chunk));

    const harness = FakeDshHarness.instances[0]!;
    expect(harness.resumeCalls).toEqual([]);
    expect(harness.sessionCalls).toEqual([undefined]);
    expect(result.ok).toBe(true);
    expect(sessionLineIds(chunks)).toEqual(['session-fresh']);
  });

  it('续跑失败退回新建：用 warn 留痕，回传的是新 id 而不是旧 id', async () => {
    FakeDshHarness.resumeError = new Error('session "session-gone" not found');
    const log = recordingLog();
    const chunks: string[] = [];
    const result = await dshRunner(log).run(
      baseRequest({ sessionId: 'session-gone' }),
      (chunk) => chunks.push(chunk),
    );

    const harness = FakeDshHarness.instances[0]!;
    expect(harness.resumeCalls).toEqual(['session-gone']);
    expect(harness.sessionCalls).toHaveLength(1);

    // 节点不该因为续不上而失败
    expect(result.ok).toBe(true);
    // 但「说续上了、其实是新的」这件事必须能被看到
    expect(log.warns.map((item) => item.message)).toEqual([
      expect.stringContaining('续跑失败'),
    ]);
    expect(log.warns[0]!.detail).toMatchObject({
      sessionId: 'session-gone',
      error: 'session "session-gone" not found',
    });
    // 事实如实上报：session 行是新会话的 id
    expect(sessionLineIds(chunks)).toEqual(['session-fresh']);
  });
});

/* ------------------------------------------------------------------ *
 * claude SDK
 * ------------------------------------------------------------------ */

interface QueryCall {
  prompt: string;
  options: Record<string, unknown>;
}

/**
 * 假的 `query()`：第一次按 `failures` 决定是否抛错，之后正常产出。
 *
 * 刻意在抛错之前**一条消息都不发**——那正是 SDK 在 resume 一个不存在的会话时
 * 的行为（实测：迭代直接抛 `No conversation found with session ID`），也正是
 * 执行器允许降级的唯一前提。
 */
function fakeClaudeSdk(failures: number): {
  module: { query: (input: { prompt: string; options: Record<string, unknown> }) => unknown };
  calls: QueryCall[];
  closed: () => number;
} {
  const calls: QueryCall[] = [];
  let closedCount = 0;

  return {
    calls,
    closed: () => closedCount,
    module: {
      query: (input) => {
        const index = calls.length;
        calls.push(input);
        const shouldFail = index < failures;
        const sessionId =
          (input.options.resume as string | undefined) ??
          (input.options.sessionId as string | undefined) ??
          'uuid-fresh';
        let closed = false;
        return {
          close: () => {
            if (!closed) {
              closed = true;
              closedCount += 1;
            }
          },
          async *[Symbol.asyncIterator]() {
            if (shouldFail) {
              throw new Error(
                'Claude Code returned an error result: No conversation found with session ID: missing',
              );
            }
            yield { type: 'system', subtype: 'init', session_id: sessionId };
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: 'OK',
              session_id: sessionId,
              usage: {},
            };
          },
        };
      },
    },
  };
}

function claudeRunner(
  log: LogSink,
  failures = 0,
): { runner: ClaudeSdkRunner; calls: QueryCall[]; closed: () => number } {
  const sdk = fakeClaudeSdk(failures);
  const runner = new ClaudeSdkRunner(log);
  (runner as unknown as { sdkModule: Promise<unknown> }).sdkModule = Promise.resolve(sdk.module);
  return { runner, calls: sdk.calls, closed: sdk.closed };
}

const PINNED_UUID = 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee';
const RESUMED_UUID = '11111111-2222-5333-8444-555555555555';

describe('claude SDK 的续跑分支', () => {
  it('有 sessionId 时设 options.resume，并且不同时设 sessionId（SDK 里两者互斥）', async () => {
    const log = recordingLog();
    const { runner, calls } = claudeRunner(log);
    const chunks: string[] = [];
    const result = await runner.run(
      baseRequest({ sessionId: RESUMED_UUID }),
      (chunk) => chunks.push(chunk),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.resume).toBe(RESUMED_UUID);
    expect(calls[0]!.options.sessionId).toBeUndefined();
    expect(result.ok).toBe(true);
    // 续跑之后回传的还是同一个 id
    expect(sessionLineIds(chunks)).toEqual([RESUMED_UUID]);
    expect(log.warns).toEqual([]);
  });

  it('没有 sessionId、但 argv 里有 --session-id 时，把它钉成这一轮的会话 id', async () => {
    const log = recordingLog();
    const { runner, calls } = claudeRunner(log);
    const chunks: string[] = [];
    await runner.run(
      baseRequest({ argv: ['claude', '--session-id', PINNED_UUID] }),
      (chunk) => chunks.push(chunk),
    );

    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[0]!.options.sessionId).toBe(PINNED_UUID);
    expect(sessionLineIds(chunks)).toEqual([PINNED_UUID]);
  });

  it('既没有 sessionId 也没有 --session-id 时两个选项都不设（全新会话）', async () => {
    const log = recordingLog();
    const { runner, calls } = claudeRunner(log);
    const chunks: string[] = [];
    await runner.run(baseRequest(), (chunk) => chunks.push(chunk));

    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[0]!.options.sessionId).toBeUndefined();
    expect(sessionLineIds(chunks)).toEqual(['uuid-fresh']);
  });

  it('argv 里的 --resume 也能作为续跑来源（绕过编排器直接调这个类时）', async () => {
    const log = recordingLog();
    const { runner, calls } = claudeRunner(log);
    await runner.run(
      baseRequest({ argv: ['claude', '--resume', RESUMED_UUID] }),
      () => {},
    );
    expect(calls[0]!.options.resume).toBe(RESUMED_UUID);
  });

  it('续跑失败且一条消息都没收到：退回新建重跑，warn 留痕，结论不判失败', async () => {
    const log = recordingLog();
    const { runner, calls } = claudeRunner(log, 1);
    const chunks: string[] = [];
    const result = await runner.run(
      baseRequest({ sessionId: RESUMED_UUID }),
      (chunk) => chunks.push(chunk),
    );

    // 第一次带 resume，第二次不带
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.resume).toBe(RESUMED_UUID);
    expect(calls[1]!.options.resume).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(log.warns.map((item) => item.message)).toEqual([
      expect.stringContaining('续跑失败'),
    ]);
    // 事实如实上报：session 行是新建会话的 id
    expect(sessionLineIds(chunks)).toEqual(['uuid-fresh']);
  });

  it('已经收到消息之后再失败，不降级重跑（避免重放半轮副作用）', async () => {
    const calls: QueryCall[] = [];
    const log = recordingLog();
    const runner = new ClaudeSdkRunner(log);
    (runner as unknown as { sdkModule: Promise<unknown> }).sdkModule = Promise.resolve({
      query: (input: QueryCall) => {
        calls.push(input);
        return {
          close: () => {},
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: RESUMED_UUID };
            throw new Error('传输中途断了');
          },
        };
      },
    });

    const result = await runner.run(baseRequest({ sessionId: RESUMED_UUID }), () => {});

    // 只起了一次 query：收到过消息就不许重来
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(log.warns).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * ACP：会话开启决策（真正的 openSession 走的就是这个纯函数）
 * ------------------------------------------------------------------ */

describe('ACP 的会话开启决策', () => {
  it('有 id 且 agent 广播了 resume 能力 → 走 session/resume', () => {
    expect(
      planSessionOpening('sess-1', { sessionCapabilities: { resume: {} } } as never),
    ).toEqual({ opening: 'resume', sessionId: 'sess-1' });
  });

  it('有 id 但 agent 没广播能力 → 新建，并标记「本来要续」', () => {
    const plan = planSessionOpening('sess-1', {} as never);
    expect(plan).toEqual({
      opening: 'new',
      reason: 'agent 未广播 session/resume 能力',
      lostResume: true,
    });
  });

  it('能力字段整个缺省也算不支持', () => {
    expect(planSessionOpening('sess-1', undefined)).toMatchObject({
      opening: 'new',
      lostResume: true,
    });
    expect(planSessionOpening('sess-1', null)).toMatchObject({
      opening: 'new',
      lostResume: true,
    });
  });

  it('没有 id → 新建，且不算「本来要续」（这是正常路径，不该告警）', () => {
    expect(planSessionOpening(undefined, { sessionCapabilities: { resume: {} } } as never)).toEqual({
      opening: 'new',
      reason: '本次执行没有可续跑的会话 id',
      lostResume: false,
    });
  });
});
