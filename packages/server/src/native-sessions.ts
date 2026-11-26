import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentProfile } from '@orchestrator/core';
import { isMissing } from './project-files.js';
import { removeCodexThreads } from './runners/codex.js';

export interface NativeSession {
  agentId: string;
  sessionId: string;
}

export interface SessionCleanup {
  deleted: number;
  archived: number;
  unmanaged: number;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Remove exact owned session directories from the Harness v4 store. */
export async function removeHarnessSessions(root: string, ids: Set<string>): Promise<number> {
  try {
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) {
      throw new Error('DeepSeek 会话目录的真实位置与配置不符。');
    }
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let deleted = 0;
  for (const bucket of await readdir(root, { withFileTypes: true })) {
    if (!bucket.isDirectory() || !/^--[\w.~\-]+--$/.test(bucket.name)) continue;
    const project = join(root, bucket.name);
    if (await realpath(project).catch(() => '') !== project || dirname(project) !== root) continue;
    for (const entry of await readdir(project, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ids.has(entry.name) || !UUID.test(entry.name)) continue;
      const path = join(project, entry.name);
      try {
        if (!(await lstat(path)).isDirectory() || await realpath(path) !== path || dirname(path) !== project) continue;
        const files = await readdir(path, { withFileTypes: true });
        if (!files.some((file) => file.isFile() && /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(file.name))) continue;
        await rm(path, { recursive: true, force: true });
        deleted += 1;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
  return deleted;
}

export async function cleanNativeSessions(refs: NativeSession[], agentFor: (id: string) => AgentProfile | undefined) {
  const result: SessionCleanup = { deleted: 0, archived: 0, unmanaged: 0 };
  const groups = new Map<string, Set<string>>();
  for (const { agentId, sessionId } of refs) {
    const ids = groups.get(agentId) ?? new Set<string>();
    ids.add(sessionId);
    groups.set(agentId, ids);
  }
  for (const [agentId, sessions] of groups) {
    const agent = agentFor(agentId);
    const ids = [...sessions].filter((id) => UUID.test(id));
    result.unmanaged += sessions.size - ids.length;
    if (!ids.length) continue;
    try {
      if (agent?.transport === 'codex-app-server' || agentId === 'codex') {
        const cleanup = await removeCodexThreads(agent?.launch.bin ?? 'codex', homedir(), ids);
        result.deleted += cleanup.deleted;
        result.archived += cleanup.archived;
      } else if (agentId === 'dsh-acp' || agent?.transport === 'dsh-sdk') {
        const root = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions');
        result.deleted += await removeHarnessSessions(root, new Set(ids));
      } else if (agent?.transport === 'claude-sdk') {
        const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
        if (typeof deleteSession !== 'function') {
          result.unmanaged += ids.length;
          continue;
        }
        for (const id of ids) {
          try {
            await deleteSession(id);
            result.deleted += 1;
          } catch (error) {
            if (!/not found|does not exist/i.test((error as Error).message)) throw error;
          }
        }
      } else {
        result.unmanaged += ids.length;
      }
    } catch (error) {
      throw new Error((agent?.label ?? agentId) + ' 的本地会话未能清理。请确认会话已关闭后重试。', { cause: error });
    }
  }
  return result;
}
