import { randomUUID } from 'node:crypto';
import type { AgentCancelRequest, AgentProfile, AgentRunner, AgentRunRequest, AgentRunResult } from '@orchestrator/core';
import { z } from 'zod';
import { ownedPath, readOptional, writeAtomic } from './project-files.js';
import { activeKey, belongsToRun } from './runner-key.js';

export const externalModelId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/, '请输入服务商提供的模型 ID。');
export const providerInput = z.object({
  label: z.string().trim().min(1).max(60),
  protocol: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().trim().url().max(600),
  apiKey: z.string().trim().min(1).max(2048).regex(/^[\x21-\x7e]+$/).optional(),
  model: externalModelId.optional(),
});

export type ProviderInput = z.infer<typeof providerInput>;
interface Provider extends ProviderInput { id: string }
export interface ModelOption { id: string; name: string; group?: string }
export interface ModelDirectory {
  models: ModelOption[];
  defaultModel?: string;
  source: string;
  checkedAt: string;
  message?: string;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

function normalize(input: ProviderInput): ProviderInput {
  const url = new URL(input.baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash || url.search) {
    throw new ProviderError('请提供 HTTPS 服务地址。HTTP 可用于本机接口。');
  }
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|messages|models)\/?$/, '').replace(/\/+$/, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return { ...input, baseUrl: url.toString().replace(/\/$/, '') };
}

function publicProvider({ apiKey, ...provider }: Provider) {
  return { ...provider, hasKey: Boolean(apiKey) };
}

async function request(input: ProviderInput, path: string, signal: AbortSignal, body?: object) {
  const headers = new Headers({ Accept: 'application/json' });
  if (body) headers.set('Content-Type', 'application/json');
  if (input.protocol === 'anthropic') {
    headers.set('anthropic-version', '2023-06-01');
    if (input.apiKey) headers.set('x-api-key', input.apiKey);
  } else if (input.apiKey) {
    headers.set('Authorization', 'Bearer ' + input.apiKey);
  }
  let response: Response;
  try {
    response = await fetch(input.baseUrl + path, { method: body ? 'POST' : 'GET', headers,
      body: body ? JSON.stringify(body) : undefined, signal, redirect: 'error' });
  } catch (error) {
    signal.throwIfAborted();
    throw new ProviderError('无法连接模型接口，请检查地址和网络。', 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError('模型接口返回 HTTP ' + response.status + '。' +
      (response.status === 401 || response.status === 403 ? '请检查密钥和模型权限。' : ''), 502);
  }
  return response;
}

async function readJson(response: Response, limit = 4 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new ProviderError('模型接口未返回内容。', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let value = '';
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > limit) throw new ProviderError('模型接口返回内容过大。', 502);
      value += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(value + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SyntaxError) throw new ProviderError('模型接口返回的数据格式无效。', 502);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const modelResponse = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })),
  has_more: z.boolean().optional(), last_id: z.string().nullable().optional(),
});

export async function listProviderModels(input: ProviderInput): Promise<ModelDirectory> {
  const provider = normalize(input);
  const signal = AbortSignal.timeout(12_000);
  const items = new Map<string, ModelOption>();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const path = '/models' + (cursor ? '?after_id=' + encodeURIComponent(cursor) : '');
    const data = modelResponse.parse(await readJson(await request(provider, path, signal)));
    for (const model of data.data) {
      if (externalModelId.safeParse(model.id).success) items.set(model.id, { id: model.id, name: model.display_name ?? model.id });
    }
    if (provider.protocol !== 'anthropic' || !data.has_more || !data.last_id || data.last_id === cursor) break;
    cursor = data.last_id;
  }
  return { models: [...items.values()], defaultModel: input.model, source: '服务商模型列表', checkedAt: new Date().toISOString() };
}

export class ModelProviders {
  private items: Provider[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}

  async load() {
    const raw = await readOptional(await ownedPath(this.root, 'model-providers.json'));
    if (raw) this.items = z.array(providerInput.extend({ id: z.string() })).parse(JSON.parse(raw)).map(({ id, ...entry }) => ({ id, ...normalize(entry) }));
  }

  list() { return this.items.map(publicProvider); }
  get(id: string) { return this.items.find((item) => item.id === id); }

  profiles(): AgentProfile[] {
    return this.items.map(({ id, label }) => ({
      id, label, vendor: '自定义模型', logo: '', transport: 'http-model',
      launch: { bin: 'http-model', args: [], stdin: true, parser: 'plain' },
      capabilities: { structured: true, tools: false, resume: false, streaming: true },
      availability: 'ready', enabled: true, session: { derive: 'none', resumeArgs: [] },
      permissionArgs: { default: [], 'accept-edits': [], auto: [], 'bypass-permissions': [] },
      timeoutMs: 180_000,
    }));
  }

  private change(mutate: (items: Provider[]) => Provider[]) {
    const next = this.pending.catch(() => {}).then(async () => {
      const items = mutate(this.items);
      await writeAtomic(await ownedPath(this.root, 'model-providers.json'), JSON.stringify(items, null, 2) + '\n', 0o600);
      this.items = items;
      return this.list();
    });
    this.pending = next;
    return next;
  }

  save(id: string | undefined, input: ProviderInput) {
    const provider = normalize(input);
    return this.change((items) => {
      if (!id) return [...items, { ...provider, id: 'provider-' + randomUUID() }];
      const previous = items.find((entry) => entry.id === id);
      if (!previous) throw new ProviderError('没有找到该模型接口。', 404);
      // A key may be reused only for the exact protocol and service URL.
      const sameService = previous.baseUrl === provider.baseUrl && previous.protocol === provider.protocol;
      return items.map((entry) => entry.id === id
        ? { ...provider, id, apiKey: provider.apiKey ?? (sameService ? previous.apiKey : undefined) }
        : entry);
    });
  }

  remove(id: string) { return this.change((items) => items.filter((entry) => entry.id !== id)); }
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function completion(value: unknown, protocol: ProviderInput['protocol'], stream: boolean): string {
  const data = obj(value);
  if (data.error || data.type === 'error') throw new ProviderError('模型在生成回复时返回错误。', 502);
  if (protocol === 'anthropic') {
    if (stream) {
      const part = obj(data.delta);
      const block = obj(data.content_block);
      const text = part.type === 'text_delta' ? part.text : block.type === 'text' ? block.text : undefined;
      return typeof text === 'string' ? text : '';
    }
    return (Array.isArray(data.content) ? data.content : []).map((part) =>
      part?.type === 'text' && typeof part.text === 'string' ? part.text : '',
    ).join('');
  }
  const first = obj(Array.isArray(data.choices) ? data.choices[0] : undefined);
  const item = obj(stream ? first.delta : first.message);
  return typeof item.content === 'string' ? item.content : '';
}

async function readReply(response: Response, provider: Provider, emit: (part: string) => void) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    emit(completion(await readJson(response), provider.protocol, false));
    return;
  }
  if (!response.body) throw new ProviderError('模型接口没有返回流。', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let doneFrame = false;
  function dispatch() {
    if (!data.length) return;
    const event = data.join('\n');
    data = [];
    if (event === '[DONE]') { doneFrame = true; return; }
    const frame: unknown = JSON.parse(event);
    if (obj(frame).type === 'message_stop') doneFrame = true;
    const text = completion(frame, provider.protocol, true);
    if (text) emit(text);
  }
  function line(value: string) {
    if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
    else if (!value) dispatch();
  }
  try {
    while (!doneFrame) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 1024 * 1024) throw new ProviderError('模型返回了过长的流式数据块。', 502);
      let next: number;
      while (!doneFrame && (next = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, next).replace(/\r$/, ''));
        pending = pending.slice(next + 1);
      }
      if (done) { if (pending) line(pending.replace(/\r$/, '')); dispatch(); break; }
    }
    if (!doneFrame) throw new ProviderError('模型回复在结束前断开，请重试。', 502);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class HttpModelRunner implements AgentRunner {
  private readonly active = new Map<string, { abort: AbortController; settled: Promise<void> }>();
  constructor(private readonly providers: ModelProviders) {}

  async run(job: AgentRunRequest, onChunk: (chunk: string) => void): Promise<AgentRunResult> {
    const provider = this.providers.get(job.agentId);
    const model = job.model || provider?.model;
    if (!provider || !model) return { ok: false, exitCode: null, output: '', error: '请先在模型接口选择模型。' };
    const abort = new AbortController();
    const timeout = AbortSignal.timeout(job.timeoutMs);
    const signal = AbortSignal.any([abort.signal, timeout, ...(job.signal ? [job.signal] : [])]);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const key = activeKey(job.runId, job.nodeId);
    this.active.set(key, { abort, settled });
    let output = '';
    try {
      const prompt = job.stdin ?? '';
      const messages = [{ role: 'user', content: prompt }];
      const isAnthropic = provider.protocol === 'anthropic';
      const response = await request(provider, isAnthropic ? '/messages' : '/chat/completions', signal, {
        model, messages, stream: true, ...(isAnthropic ? { max_tokens: 8192 } : {}),
      });
      await readReply(response, provider, (part) => {
        if (output.length + part.length > 280_000) throw new ProviderError('模型答复过长，请缩小议题后重试。');
        output += part;
        onChunk(part);
      });
      signal.throwIfAborted();
      return output.trim() ? { ok: true, exitCode: 0, output } : { ok: false, exitCode: 1, output, error: '模型没有返回正文。' };
    } catch (error) {
      const cancelled = abort.signal.aborted || Boolean(job.signal?.aborted);
      return { ok: false, exitCode: null, output, cancelled, timedOut: timeout.aborted && !cancelled,
        error: error instanceof ProviderError ? error.message : timeout.aborted ? '模型接口超时。' : cancelled ? '已中断。' : '模型回复读取失败。' };
    } finally {
      if (this.active.get(key)?.abort === abort) this.active.delete(key);
      settle();
    }
  }

  async cancel(target: AgentCancelRequest): Promise<number> {
    const slots = [...this.active].filter(([key]) => target.nodeId === undefined
      ? belongsToRun(key, target.runId) : key === activeKey(target.runId, target.nodeId));
    for (const [, slot] of slots) slot.abort.abort();
    await Promise.all(slots.map(([, slot]) => slot.settled));
    return slots.length;
  }
}
