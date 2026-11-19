import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { NodeArtifact } from '@orchestrator/core';
import { assertRunId, ownedPath } from './project-files.js';

/**
 * 节点产物落盘。
 *
 * diff 原文不写进事件日志：日志要能整份重放，塞进几百 KB 的 diff
 * 会让重放变成一次批量 IO。这里只留文件和路径，事件里放统计量。
 */
export class ArtifactStore {
  constructor(private readonly rootDir: string, private readonly singleRun = false) {}

  /**
   * 路径净化。
   *
   * runId / nodeId 来自 Planner 产出的 DAG，属于外部输入；
   * 直接拼进路径就等于把目录穿越的口子交给了模型，
   * 所以这里把非 `.`-`_`-`-` 的字符一律替换掉。
   */
  private segmentOf(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
  }

  private pathOf(runId: string, nodeId: string): string {
    return resolve(this.rootDir, this.singleRun ? '' : this.segmentOf(runId), `${this.segmentOf(nodeId)}.diff`);
  }

  async removeLegacyRun(runId: string): Promise<void> {
    assertRunId(runId);
    await rm(await ownedPath(this.rootDir, runId), { recursive: true, force: true });
  }

  /** 返回 diff 文件路径；目录按需创建。 */
  async save(runId: string, nodeId: string, artifact: NodeArtifact): Promise<string> {
    const path = this.pathOf(runId, nodeId);
    await mkdir(dirname(path), { recursive: true });
    // 空 diff 也照写：节点重跑却没有产出时，这一步正好把上一轮的
    // 旧 diff 覆盖掉，避免审查读到一份已经不存在的变更。
    await writeFile(path, artifact.diff, 'utf8');
    return path;
  }

  /** 读回 diff 文本。文件缺失或内容为空都视为「没有 diff」。 */
  async load(runId: string, nodeId: string): Promise<string | undefined> {
    try {
      const text = await readFile(this.pathOf(runId, nodeId), 'utf8');
      return text.trim() ? text : undefined;
    } catch {
      return undefined;
    }
  }
}
