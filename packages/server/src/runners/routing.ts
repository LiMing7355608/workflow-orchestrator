import type {
  AgentCancelRequest,
  AgentProfile,
  AgentRunRequest,
  AgentRunResult,
  AgentRunner,
  AgentTransport,
} from '@orchestrator/core';
import { AcpRunner } from './acp.js';
import { ClaudeSdkRunner } from './claude-sdk.js';
import { CodexAppServerRunner } from './codex.js';
import { DshSdkRunner } from './dsh-sdk.js';
import { SpawnAgentRunner } from '../runners.js';
import type { LogSink } from '../log.js';
import type { ProcessRegistry } from '../registry.js';

/**
 * 按 Agent 声明的传输方式分派执行器。
 *
 * 为什么需要它：同一个运行里的节点可能跑在不同平台上，而「走官方 SDK / 走
 * JSON-RPC 协议 / 拼 argv」是几条完全不同的执行路径。把这个判断留在编排器里，
 * 等于让调度层认识每个平台的细节；放在这里，调度层只认 `AgentRunner` 一个接口。
 *
 * 缺省当作 `'cli'`：`transport` 是后加的字段，磁盘上的旧目录、测试里手写的
 * profile 都不会带它。它们本来就是拼 argv 跑的，行为不能因为加了这个字段而变。
 */
export class RoutingAgentRunner implements AgentRunner {
  private readonly cli: SpawnAgentRunner;
  private readonly claudeSdk: ClaudeSdkRunner;
  private readonly codex: CodexAppServerRunner;
  private readonly dshSdk: DshSdkRunner;
  private readonly acp: AcpRunner;
  private readonly http?: AgentRunner;

  constructor(
    /**
     * 解析某个 agentId 用哪种传输。
     *
     * 传函数而不是目录快照：`catalog` 在服务端是 `let`，探测之后会被整体替换。
     * 捕获那一刻的数组，等于让分派器永远停在启动时的判断上——用户后来装了某个
     * 平台、或目录里改了 transport，都得重启才生效。
     */
    private readonly resolveTransport: (agentId: string) => AgentTransport,
    options: { registry?: ProcessRegistry; log?: LogSink; http?: AgentRunner } = {},
  ) {
    this.http = options.http;
    this.cli = new SpawnAgentRunner(options.registry, options.log);
    this.claudeSdk = new ClaudeSdkRunner(options.log);
    this.codex = new CodexAppServerRunner(options.log);
    this.dshSdk = new DshSdkRunner(options.log);
    // ACP 要账本：它的进程同样是本机真实跑着的子进程，不登记就没人收拾
    this.acp = new AcpRunner(options.log, options.registry);
  }

  /** 兜底用 CLI：认不出的 transport 值不该让节点一次都不跑。 */
  private pick(agentId: string): AgentRunner {
    switch (this.resolveTransport(agentId)) {
      case 'claude-sdk':
        return this.claudeSdk;
      case 'codex-app-server':
        return this.codex;
      case 'dsh-sdk':
        return this.dshSdk;
      case 'http-model':
        if (!this.http) throw new Error('未配置 HTTP 模型执行器。');
        return this.http;
      case 'acp':
        return this.acp;
      default:
        return this.cli;
    }
  }

  run(
    request: AgentRunRequest,
    onChunk: (chunk: string) => void,
  ): Promise<AgentRunResult> {
    return this.pick(request.agentId).run(request, onChunk);
  }

  /**
   * 取消要**广播**给所有执行器。
   *
   * 不按 transport 只投一家：我们手里只有一个 runId/nodeId，没有「它当初落在
   * 哪条路上」的可靠记录——运行中途改过 agent、或者重启后内存表已清空，都会
   * 让「按当前 profile 猜」猜错。让每个执行器各自判断自己表里有没有这个键，
   * 谁都可能命中，谁都不该被跳过。
   *
   * 返回的是**确认**终止的数量之和，与单一执行器的语义一致：发出去不等于停住了。
   */
  async cancel(request: AgentCancelRequest): Promise<number> {
    const outcomes = await Promise.all([
      this.cli.cancel(request).catch(() => 0),
      this.claudeSdk.cancel(request).catch(() => 0),
      this.codex.cancel(request).catch(() => 0),
      this.dshSdk.cancel(request).catch(() => 0),
      this.acp.cancel(request).catch(() => 0),
      this.http?.cancel?.(request).catch(() => 0) ?? Promise.resolve(0),
    ]);
    return outcomes.reduce((sum, count) => sum + count, 0);
  }
}

/**
 * 从一份 profile 目录造一个 transport 解析函数。
 *
 * 传 getter 而不是数组，理由见 `RoutingAgentRunner` 构造函数的注释。
 * 找不到就按缺省 `'cli'`：未知 Agent 走最保守的那条路。
 */
export function transportResolver(
  getCatalog: () => readonly AgentProfile[],
): (agentId: string) => AgentTransport {
  return (agentId) =>
    getCatalog().find((profile) => profile.id === agentId)?.transport ?? 'cli';
}
