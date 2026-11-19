import { buildAgentArgv, createParser, type AgentProfile, type AgentRunner } from '@orchestrator/core';
import { z } from 'zod';

export const modelIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/, '请输入客户端认识的模型 ID。');

export function supportsModel(agent: AgentProfile): boolean {
  return agent.transport === 'acp' || agent.transport === 'codex-app-server' ||
    agent.transport === 'claude-sdk' || (!agent.transport || agent.transport === 'cli') && Boolean(agent.launch.modelArgs);
}

interface TextTurn {
  runId: string;
  nodeId: string;
  cwd: string;
  prompt: string;
  model?: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

export async function runTextTurn(runner: AgentRunner, agent: AgentProfile, turn: TextTurn): Promise<string[]> {
  if (turn.model && !supportsModel(agent)) throw new Error('该 Agent 使用客户端配置的模型。');
  const policy = 'default';
  const parser = createParser(agent.launch.parser);
  const argv = buildAgentArgv(agent, {
    prompt: turn.prompt, workdir: turn.cwd, policy,
    model: agent.transport === 'acp' ? undefined : turn.model,
  });
  let text = '';
  let final = '';
  function collect(events: ReturnType<typeof parser.push>) {
    for (const event of events) {
      if ((event.kind === 'text' || event.kind === 'result') && event.text) {
        if (event.kind === 'result') final = event.text.slice(-48_000);
        else text = (text + event.text).slice(-48_000);
        const progress = (event.kind === 'result' ? final : text).trim();
        if (progress) turn.onText?.(progress);
      }
    }
  }
  const result = await runner.run({
    runId: turn.runId, nodeId: turn.nodeId, agentId: agent.id, bin: agent.launch.bin,
    argv, cwd: turn.cwd, policy, model: turn.model, reasoningEffort: 'low', signal: turn.signal,
    stdin: agent.launch.stdin ? turn.prompt : undefined, timeoutMs: Math.min(agent.timeoutMs, 180_000),
  }, (chunk) => collect(parser.push(chunk)));
  collect(parser.finish());
  turn.signal?.throwIfAborted();
  if (!result.ok) throw new Error(result.error || 'Agent 调用未完成，请检查客户端并重试。');
  return [final, text, result.output].filter(Boolean);
}

export function readTurnJson<T>(texts: string[], schema: z.ZodType<T>, error: string): T {
  for (const value of texts) {
    const first = value.indexOf('{');
    const last = value.lastIndexOf('}');
    if (first < 0 || last <= first) continue;
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    for (const json of [value.slice(first, last + 1), fenced].filter((candidate): candidate is string => Boolean(candidate))) {
      try {
        const parsed = schema.safeParse(JSON.parse(json));
        if (parsed.success) return parsed.data;
      } catch {
        // A plain JSON answer can contain fenced Markdown of its own.
      }
    }
  }
  throw new Error(error);
}
