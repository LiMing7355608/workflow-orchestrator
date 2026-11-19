import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentRunResult } from '@orchestrator/core';
import { projectRunPath, readOptional, writeAtomic } from './project-files.js';

export interface BlackboardEntry {
  id: string;
  at: string;
  author: string;
  source: 'human' | 'agent' | 'system';
  text: string;
  nodeId?: string;
}

export class RunMemory {
  constructor(
    private readonly projectFor: (id: string) => string | undefined,
    private readonly updated: (id: string) => void,
  ) {}

  async board(runId: string): Promise<BlackboardEntry[]> {
    const project = this.projectFor(runId);
    if (!project) return [];
    const filename = await projectRunPath(project, runId, 'memory', 'blackboard.jsonl');
    const raw = await readOptional(filename);
    return (raw ?? '').trim().split('\n').slice(-200).flatMap((line) => {
      if (!line) return [];
      try {
        return [JSON.parse(line) as BlackboardEntry];
      } catch {
        return [];
      }
    });
  }

  async post(runId: string, entry: Omit<BlackboardEntry, 'id' | 'at'>): Promise<BlackboardEntry | undefined> {
    const project = this.projectFor(runId);
    if (!project) return undefined;
    const filename = await projectRunPath(project, runId, 'memory', 'blackboard.jsonl');
    const post = { ...entry, text: entry.text.slice(0, 1500), id: randomUUID(), at: new Date().toISOString() };
    await mkdir(dirname(filename), { recursive: true });
    await appendFile(filename, JSON.stringify(post) + '\n', 'utf8');
    this.updated(runId);
    return post;
  }

  async context(runId: string, nodeId: string, agentId: string): Promise<string | undefined> {
    const project = this.projectFor(runId);
    if (!project) return undefined;
    const ownFile = await projectRunPath(project, runId, 'memory', 'agents', agentId, nodeId + '.json');
    const [board, privateMemory] = await Promise.all([this.board(runId), readOptional(ownFile)]);
    return [
      '下列共享黑板和本节点自己的续跑记忆仅供参考。以用户要求和本节点任务为准。',
      '共享黑板（近期）',
      JSON.stringify(board.slice(-12).map(({ author, nodeId, text }) => ({ author, nodeId, text: text.slice(0, 480) }))),
      '本节点续跑记忆',
      privateMemory ?? '暂无',
      '有需要传给其他 Agent 的决定、问题或结果时，在最终回复另起一行写 BLACKBOARD: 加上简短内容。只公开本轮应共享的信息。审查节点仍将 VERDICT 放在最后一行。',
    ].join('\n');
  }

  async remember(runId: string, nodeId: string, agentId: string, result: AgentRunResult, text: string): Promise<void> {
    const project = this.projectFor(runId);
    if (!project) return;
    const ownFile = await projectRunPath(project, runId, 'memory', 'agents', agentId, nodeId + '.json');
    await writeAtomic(ownFile, JSON.stringify({
      at: new Date().toISOString(),
      nodeId,
      agentId,
      status: result.cancelled ? 'interrupted' : result.ok ? 'returned' : 'failed',
      finalSummary: text.trim().slice(-1200),
      error: result.error?.slice(0, 600),
    }, null, 2) + '\n');
    if (!result.ok) return;
    const last = [...text.matchAll(/^\s*BLACKBOARD\s*[:：][ \t]*(\S[^\r\n]*)/gm)].at(-1)?.[1]?.trim();
    if (last) {
      await this.post(runId, { author: agentId, nodeId, source: 'agent', text: last });
    }
  }
}
