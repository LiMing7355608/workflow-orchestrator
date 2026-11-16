/**
 * 事件日志的落盘实现。
 *
 * 单独成一个入口（`@orchestrator/core/node`），因为这里用到 Node 内置模块，
 * 前端不应该被动把它打进包里。纯逻辑仍在 `journal.ts`。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OrchestratorEvent } from './types.js';

export async function appendEvent(
  filePath: string,
  event: OrchestratorEvent,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

/** 读取日志。损坏的行跳过，而不是让整个运行起不来。 */
export async function loadEvents(
  filePath: string,
): Promise<OrchestratorEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const events: OrchestratorEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as OrchestratorEvent);
    } catch {
      // 写到一半被中断的行直接丢弃，保留可解析的部分
    }
  }
  return events;
}
