import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { HttpModelRunner, ModelProviders } from '../src/model-providers.js';

it('接入两种模型接口，密钥只用于同一服务，模型选择随请求生效', async () => {
  const data = await mkdtemp(join(tmpdir(), 'workflow-provider-'));
  const server = createServer(async (request, response) => {
    const anthropic = request.url?.startsWith('/anthropic');
    const key = anthropic ? request.headers['x-api-key'] : request.headers.authorization;
    if (key !== (anthropic ? 'local-fixture-key' : 'Bearer local-fixture-key')) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-latest' }] }));
      return;
    }
    const parts = [];
    for await (const buffer of request) parts.push(buffer);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const output = body.model + ' · ' + body.messages[0].content;
    if (anthropic) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ content: [{ type: 'text', text: output }] }));
    } else {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output.slice(0, 5) } }] }) + '\r\n\r\n');
      response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: output.slice(5) } }] }) + '\r\n\r\ndata: [DONE]\r\n\r\n');
    }
  });
  const bound = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await bound;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback address');
  const base = 'http://127.0.0.1:' + address.port;
  let context: AppContext | undefined;
  try {
    context = await buildApp({ logPath: join(data, 'events.jsonl'), logger: false, catalog: [] });
    const api = context.app;
    const save = (payload: object) => api.inject({ method: 'POST', url: '/api/model-providers', payload });
    for (const protocol of ['openai', 'anthropic'] as const) {
      const baseUrl = base + (protocol === 'openai' ? '/v1' : '/anthropic/v1');
      const response = await save({ label: protocol, protocol, baseUrl, apiKey: 'local-fixture-key', model: 'local-default' });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('local-fixture-key');
      const id = response.json().at(-1).id;
      expect((await api.inject('/api/agents/' + id + '/models?refresh=true')).json().models).toEqual([{ id: 'local-latest', name: 'local-latest' }]);
      await save({ id, label: '改名', protocol, baseUrl, model: 'local-default' });
      const providers = new ModelProviders(data);
      await providers.load();
      const runner = new HttpModelRunner(providers);
      const chunks: string[] = [];
      const result = await runner.run({
        runId: 'spec-1', nodeId: 'turn-1', agentId: id, bin: 'http-model', argv: [],
        cwd: data, policy: 'default', timeoutMs: 3000, stdin: '指定测试正文', model: 'local-latest',
      }, (chunk) => chunks.push(chunk));
      expect(result).toMatchObject({ ok: true, output: 'local-latest · 指定测试正文' });
      expect(chunks.join('')).toBe(result.output);
      expect(await save({ id, label: '改地址', protocol, baseUrl: base + '/different', model: 'local-latest' })
        .then((res) => res.json().find((entry: { id: string }) => entry.id === id).hasKey)).toBe(false);
    }
  } finally {
    await context?.app.close();
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
    await rm(data, { recursive: true, force: true });
  }
}, 15_000);
