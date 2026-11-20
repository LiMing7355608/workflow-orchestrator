import { mkdir } from 'node:fs/promises';
import type { AgentProfile } from '@orchestrator/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { listProviderModels, ModelProviders, ProviderError, providerInput, type ModelDirectory } from './model-providers.js';
import { ownedPath } from './project-files.js';
import { listAcpModels } from './runners/acp.js';
import { listCodexModels } from './runners/codex.js';

const profileId = z.string().regex(/^provider-[a-f0-9-]{36}$/);
const writeModel = providerInput.extend({ id: profileId.optional() });

export function registerModelRoutes(app: FastifyInstance, providers: ModelProviders, dataRoot: string,
  catalog: () => AgentProfile[], changed: () => void) {
  const cache = new Map<string, { time: number; directory: ModelDirectory }>();
  const requests = new Map<string, Promise<ModelDirectory>>();
  let revision = 0;

  async function respond<T>(reply: FastifyReply, action: () => T | Promise<T>) {
    reply.header('Cache-Control', 'no-store');
    try {
      return await action();
    } catch (error) {
      if (error instanceof ProviderError) return reply.code(error.status).send({ message: error.message });
      return reply.code(502).send({ message: '暂时无法读取模型接口，请检查客户端登录、版本或网络。也可以填写模型 ID。' });
    }
  }

  async function modelList(agent: AgentProfile): Promise<ModelDirectory> {
    if (agent.transport === 'http-model') {
      const provider = providers.get(agent.id);
      if (!provider) throw new ProviderError('未找到模型接口。', 404);
      return listProviderModels(provider);
    }
    if (agent.transport === 'acp' || agent.transport === 'codex-app-server') {
      const cwd = await ownedPath(dataRoot, 'model-catalog');
      await mkdir(cwd, { recursive: true });
      return agent.transport === 'acp' ? listAcpModels(agent, cwd) : listCodexModels(agent.launch.bin, cwd);
    }
    return { models: [], checkedAt: new Date().toISOString(), source: '本地客户端',
      message: '当前客户端未提供可读取的模型列表。' };
  }

  function invalidate() {
    revision += 1;
    cache.clear();
    requests.clear();
    changed();
  }

  app.get('/api/model-providers', (_request, reply) => respond(reply, () => providers.list()));
  app.post('/api/model-providers', (request, reply) => respond(reply, async () => {
    const parsed = writeModel.safeParse(request.body);
    if (!parsed.success) throw new ProviderError('请检查名称、服务地址、密钥或默认模型 ID。', 400);
    const { id, ...input } = parsed.data;
    const records = await providers.save(id, input);
    invalidate();
    return records;
  }));
  app.delete<{ Params: { id: string } }>('/api/model-providers/:id', (request, reply) => respond(reply, async () => {
    const parsed = profileId.safeParse(request.params.id);
    if (!parsed.success || !providers.get(parsed.data)) throw new ProviderError('未找到模型接口。', 404);
    const records = await providers.remove(parsed.data);
    invalidate();
    return records;
  }));
  app.post('/api/model-providers/discover', (request, reply) => respond(reply, () => {
    const parsed = writeModel.safeParse(request.body);
    if (!parsed.success) throw new ProviderError('请先检查模型接口配置。', 400);
    const { id, ...input } = parsed.data;
    const previous = id ? providers.get(id) : undefined;
    const sameService = previous?.baseUrl === input.baseUrl && previous.protocol === input.protocol;
    return listProviderModels({ ...input, apiKey: input.apiKey ?? (sameService ? previous.apiKey : undefined) });
  }));
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/api/agents/:id/models',
    (request, reply) => respond(reply, async () => {
      const agent = catalog().find(({ id }) => id === request.params.id);
      if (!agent || !agent.enabled || agent.availability === 'missing') throw new ProviderError('所选 Agent 当前不可用。', 404);
      const version = revision;
      const previous = cache.get(agent.id);
      if (request.query.refresh !== 'true' && previous && Date.now() - previous.time < 30_000) return previous.directory;
      const current = requests.get(agent.id);
      if (current) return current;
      const task = modelList(agent).then((directory) => {
        if (version === revision) cache.set(agent.id, { time: Date.now(), directory });
        return directory;
      });
      requests.set(agent.id, task);
      try { return await task; }
      finally { if (requests.get(agent.id) === task) requests.delete(agent.id); }
    }));
}
