import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_AGENT_PROFILES,
  deriveBoard,
  deriveEdges,
  deriveEvents,
  deriveRunDetail,
  deriveRunView,
  findAgent,
  type AgentProfile,
  type NodeFacts,
  type OrchestratorEvent,
  type RunFacts,
} from '@orchestrator/core';
import { parseDag, safeParseDag, validateDag } from '@orchestrator/planner';
import { probeCatalog } from './probe.js';
import { buildSeedEvents } from './seed.js';
import { RunStore } from './store.js';

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
  dag: z.unknown(),
});

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

    const dag = safeParseDag(body.data.dag);
    if (!dag.success) {
      return reply.code(400).send({ error: 'invalid_dag', issues: dag.error.issues });
    }

    // 冻结前的最后一道闸：不合法就不许进执行阶段
    const validation = validateDag(dag.data, catalog);
    if (!validation.ok) {
      return reply.code(422).send({ error: 'dag_rejected', issues: validation.issues });
    }

    const at = now();
    const runId = `run-${Date.now().toString(36)}`;
    const nodes: Record<string, NodeFacts> = {};
    for (const node of dag.data.nodes) {
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
      title: dag.data.title,
      summary: dag.data.summary,
      goal: body.data.goal,
      specVersion: dag.data.specVersion,
      stage: 'decompose',
      createdAt: at,
      nodeOrder: dag.data.nodes.map((node) => node.id),
      nodes,
    };

    await store.emit({ type: 'run.created', at, runId, run });
    await store.emit({ type: 'run.frozen', at: now(), runId });

    return reply
      .code(201)
      .send(deriveRunDetail(store.snapshot.runs[runId]!, [...store.history], resolveAgent));
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
      return { ok: true };
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
