import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_AGENT_PROFILES,
  advanceRun,
  deriveBoard,
  deriveEdges,
  deriveEvents,
  deriveRunDetail,
  deriveRunView,
  findAgent,
  type AgentProfile,
  type AgentRunner,
  type NodeFacts,
  type OrchestratorEvent,
  type RunFacts,
  type WorkspacePort,
} from '@orchestrator/core';
import {
  DagGenerationError,
  generateDag,
  parseDag,
  safeParseDag,
  validateDag,
  type Dag,
  type DagIssue,
} from '@orchestrator/planner';
import { probeCatalog } from './probe.js';
import { MockAgentRunner, SpawnAgentRunner } from './runners.js';
import { buildSeedEvents } from './seed.js';
import { RunStore } from './store.js';
import { GitWorktreeWorkspace, TempDirWorkspace } from './workspace.js';

export interface AppOptions {
  /** 事件日志路径，JSONL 追加写 */
  logPath: string;
  /** 覆盖默认 Agent 目录，测试用 */
  catalog?: AgentProfile[];
  /** 监听 0.0.0.0 时关闭 loopback 假设 */
  logger?: boolean;
}

export interface AppContext {
  app: FastifyInstance;
  store: RunStore;
  getCatalog: () => AgentProfile[];
}

const approvalBodySchema = z.object({
  decision: z.enum(['approve', 'reject', 'handoff']),
  actor: z.string().min(1).default('second-group'),
  reason: z.string().optional(),
  handoffTo: z.string().min(1).optional(),
});

const createRunBodySchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  /** 省略时由 Planner 依据 goal 现生成；显式给出则走客户端手写的老路 */
  dag: z.unknown().optional(),
});

/** 生成来源摘要，随 201 响应回给客户端；客户端自带 DAG 时为 null。 */
interface PlanSummary {
  attempts: number;
  issues: DagIssue[];
  /** 是哪一路 Agent 规划的 */
  agentId: string;
  agentLabel: string;
}

/**
 * Fastify 应用工厂。
 *
 * 拆成工厂而不是直接监听，是为了让 e2e 测试能注入自己的日志路径与目录，
 * 不必起真实端口。`main.ts` 只负责 listen。
 */
export async function buildApp(options: AppOptions): Promise<AppContext> {
  const app = Fastify({ logger: options.logger ?? false });
  const store = await RunStore.open(options.logPath, buildSeedEvents);
  const baseline = options.catalog ?? DEFAULT_AGENT_PROFILES;

  let catalog = await probeCatalog(baseline);

  const resolveAgent = (agentId: string | undefined): string | undefined =>
    findAgent(agentId, catalog)?.label;

  const now = (): string => new Date().toISOString();

  /* ---------------------------------------------------------------- *
   * 执行层：Agent 执行器与工作区
   * ---------------------------------------------------------------- */

  const runnerMode = process.env.AGENT_RUNNER ?? 'mock';
  const runner: AgentRunner =
    runnerMode === 'real' ? new SpawnAgentRunner() : new MockAgentRunner();

  const workspaceMode = process.env.AGENT_WORKSPACE ?? 'temp';
  const repoRoot = process.cwd();
  const workspace: WorkspacePort =
    workspaceMode === 'git'
      ? new GitWorktreeWorkspace(repoRoot)
      : new TempDirWorkspace(resolve(repoRoot, '.worktrees'));

  // 同一个运行不允许两条推进链路并行，否则会重复派发同一批节点
  const advancing = new Set<string>();

  async function advance(runId: string): Promise<void> {
    if (advancing.has(runId)) {
      return;
    }
    advancing.add(runId);
    try {
      await advanceRun(runId, {
        getRun: (id) => store.snapshot.runs[id],
        emit: (event) => store.emit(event),
        runner,
        workspace,
        resolveAgent: (agentId) => findAgent(agentId, catalog),
        now,
        concurrency: Number(process.env.AGENT_CONCURRENCY ?? 2),
      });
    } catch (error) {
      // 推进失败不能吞掉：写成一条事实，让看板能看见
      await store
        .emit({
          type: 'run.paused',
          at: now(),
          runId,
        })
        .catch(() => {});
      console.error(`advance failed for ${runId}`, error);
    } finally {
      advancing.delete(runId);
    }
  }

  /* ---------------------------------------------------------------- *
   * Agent 目录
   * ---------------------------------------------------------------- */

  app.get('/api/agents', async () => catalog);

  app.post('/api/agents/probe', async () => {
    // 始终基于基线重新探测：拿上一次探测结果当输入会把 ready 磨成 installed
    catalog = await probeCatalog(baseline);
    return catalog;
  });

  /* ---------------------------------------------------------------- *
   * 运行读取
   * ---------------------------------------------------------------- */

  app.get('/api/runs', async () => {
    return Object.values(store.snapshot.runs)
      .map(deriveRunView)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = store.snapshot.runs[request.params.id];
    if (!run) {
      return reply.code(404).send({ error: 'run_not_found' });
    }
    return deriveRunDetail(run, [...store.history], resolveAgent);
  });

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/board',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      const detail = deriveRunDetail(run, [...store.history], resolveAgent);
      return {
        runId: run.id,
        lanes: deriveBoard(detail.nodes, deriveEdges(run)),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/runs/:id/events',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      return deriveEvents(run, [...store.history]);
    },
  );

  /* ---------------------------------------------------------------- *
   * 运行写入
   * ---------------------------------------------------------------- */

  app.post('/api/runs', async (request, reply) => {
    const body = createRunBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    let dag: Dag;
    let plan: PlanSummary | null = null;

    if (body.data.dag !== undefined) {
      const parsed = safeParseDag(body.data.dag);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_dag', issues: parsed.error.issues });
      }
      dag = parsed.data;
    } else {
      // 规划不另开通道：走与节点相同的执行器与工作区
      try {
        const generated = await generateDag(
          body.data.goal,
          catalog,
          {
            runner,
            workspace,
            onOutput: (chunk) => {
              // 规划过程也进事件流，出问题时能看到 Agent 说了什么
              console.log('[planner]', chunk.trim().slice(0, 200));
            },
          },
          { agentId: process.env.PLANNER_AGENT_ID || undefined },
        );
        dag = generated.dag;
        plan = {
          attempts: generated.attempts,
          issues: generated.issues,
          agentId: generated.agentId,
          agentLabel: generated.agentLabel,
        };
      } catch (error) {
        if (error instanceof DagGenerationError) {
          // 图不合格是「内容问题」，用 422 把 issues 原样交给调用方去展示
          return reply.code(422).send({
            error: 'plan_rejected',
            message: error.message,
            issues: error.issues,
            attempts: error.attempts,
          });
        }
        // Agent 跑不起来属于编排器自身问题，与用户目标无关
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(502).send({ error: 'planner_failed', message, issues: [] });
      }
    }

    // 冻结前的最后一道闸：不合法就不许进执行阶段
    const validation = validateDag(dag, catalog);
    if (!validation.ok) {
      return reply.code(422).send({ error: 'dag_rejected', issues: validation.issues });
    }

    const at = now();
    const runId = `run-${Date.now().toString(36)}`;
    const nodes: Record<string, NodeFacts> = {};
    for (const node of dag.nodes) {
      nodes[node.id] = {
        id: node.id,
        type: node.type,
        title: node.title,
        description: node.description,
        dependsOn: node.dependsOn,
        files: node.files,
        agentId: node.agentId,
        executor: node.executor,
        attempts: 0,
        maxAttempts: node.maxAttempts,
      };
    }

    const run: RunFacts = {
      id: runId,
      title: dag.title,
      summary: dag.summary,
      goal: body.data.goal,
      specVersion: dag.specVersion,
      stage: 'decompose',
      createdAt: at,
      nodeOrder: dag.nodes.map((node) => node.id),
      nodes,
    };

    await store.emit({ type: 'run.created', at, runId, run });
    await store.emit({ type: 'run.frozen', at: now(), runId });

    // 冻结即可开跑，不必等客户端再踢一脚
    void advance(runId);

    // plan 恒存在：客户端自带 DAG 时为 null，前端不必区分两种响应形状
    return reply.code(201).send({
      ...deriveRunDetail(store.snapshot.runs[runId]!, [...store.history], resolveAgent),
      plan,
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/pause',
    async (request, reply) => {
      if (!store.snapshot.runs[request.params.id]) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      await store.emit({ type: 'run.paused', at: now(), runId: request.params.id });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/resume',
    async (request, reply) => {
      if (!store.snapshot.runs[request.params.id]) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      await store.emit({ type: 'run.resumed', at: now(), runId: request.params.id });
      void advance(request.params.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/advance',
    async (request, reply) => {
      const run = store.snapshot.runs[request.params.id];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      await advance(request.params.id);
      return deriveRunDetail(
        store.snapshot.runs[request.params.id]!,
        [...store.history],
        resolveAgent,
      );
    },
  );

  /* ---------------------------------------------------------------- *
   * 审批：不可变追加，不阻塞进程
   * ---------------------------------------------------------------- */

  app.get('/api/approvals', async () => {
    const pending = store.snapshot.approvals.filter(
      (record) => record.status === 'pending',
    );
    return pending.map((record) => ({
      ...record,
      runTitle: store.snapshot.runs[record.runId]?.title ?? record.runId,
      nodeTitle:
        store.snapshot.runs[record.runId]?.nodes[record.nodeId]?.title ??
        record.nodeId,
    }));
  });

  app.post<{ Params: { id: string; nodeId: string } }>(
    '/api/runs/:id/nodes/:nodeId/approval',
    async (request, reply) => {
      const { id: runId, nodeId } = request.params;
      const run = store.snapshot.runs[runId];
      if (!run) {
        return reply.code(404).send({ error: 'run_not_found' });
      }
      const node = run.nodes[nodeId];
      if (!node || node.type !== 'approval') {
        return reply.code(404).send({ error: 'approval_node_not_found' });
      }

      const body = approvalBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }

      const record = store.snapshot.approvals.find(
        (item) => item.runId === runId && item.nodeId === nodeId && item.status === 'pending',
      );
      if (!record) {
        return reply.code(409).send({ error: 'no_pending_approval' });
      }

      const at = now();
      await store.emit({
        type: 'approval.decided',
        at,
        runId,
        approvalId: record.id,
        decision: body.data.decision,
        actor: body.data.actor,
        reason: body.data.reason,
      });
      await store.emit({ type: 'node.completed', at, runId, nodeId });

      if (body.data.decision === 'reject') {
        // 驳回不改图结构，只重置目标实现节点；下游已完成的事实一并作废
        const target = node.dependsOn[0];
        if (target) {
          await store.emit({
            type: 'node.reset',
            at: now(),
            runId,
            nodeId: target,
            reason: body.data.reason ?? '审批驳回',
          });
        }
      }

      if (body.data.decision === 'handoff') {
        const nextAt = now();
        await store.emit({
          type: 'approval.requested',
          at: nextAt,
          runId,
          record: {
            id: `${record.id}-handoff-${Date.now().toString(36)}`,
            runId,
            nodeId,
            status: 'pending',
            requestedAt: nextAt,
            handedOffTo: body.data.handoffTo,
          },
        });
      }

      // 审批落盘后接着往下跑：批准放行下游，驳回则重跑被退回的节点
      void advance(runId);

      return deriveRunDetail(store.snapshot.runs[runId]!, [...store.history], resolveAgent);
    },
  );

  /* ---------------------------------------------------------------- *
   * SSE：编排层只发布，看板只订阅
   * ---------------------------------------------------------------- */

  app.get('/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const unsubscribe = store.bus.subscribe((event: OrchestratorEvent) => {
      const run = store.snapshot.runs[event.runId];
      const view = run ? deriveEvents(run, [event])[0] : undefined;
      reply.raw.write(
        `data: ${JSON.stringify({ runId: event.runId, event: view, raw: event })}\n\n`,
      );
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/api/health', async () => ({
    ok: true,
    runs: Object.keys(store.snapshot.runs).length,
    approvals: store.snapshot.approvals.filter((record) => record.status === 'pending').length,
    events: store.history.length,
  }));

  return { app, store, getCatalog: () => catalog };
}

export { parseDag };
