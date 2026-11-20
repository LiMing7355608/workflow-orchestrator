import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const PROJECT_DATA = '.workflow-orchestrator';

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function assertRunId(runId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('运行编号不能用作项目路径');
  }
}

export function projectRunsRoot(root: string): string {
  return join(root, PROJECT_DATA, 'runs');
}

/**
 * Prevent a managed file path from following a link or Windows junction outside
 * the selected workspace. A missing component is valid for first use.
 */
export async function ownedPath(root: string, ...parts: string[]): Promise<string> {
  let path = resolve(root);
  async function rejectLink() {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`项目数据路径不能是符号链接或联接：${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  await rejectLink();
  for (const part of parts) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') {
      throw new Error('无效的项目数据路径');
    }
    path = join(path, part);
    await rejectLink();
  }
  return path;
}

export async function projectRunPath(root: string, runId: string, ...parts: string[]): Promise<string> {
  assertRunId(runId);
  return ownedPath(root, PROJECT_DATA, 'runs', runId, ...parts);
}

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
