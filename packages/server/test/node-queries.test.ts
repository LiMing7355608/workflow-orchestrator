import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/artifacts';
import { buildApp } from '../src/app';

/**
 * 节点查询接口（产物 diff / 节点事件）的 HTTP 层测试。
 *
 * 走真的 `buildApp` + `app.inject`，不起端口：这两个接口的价值全在
 * 「404 与空内容不能混为一谈」上，只有经过真实的路由与状态码才测得到。
 * Agent 目录传空数组，把探测（`where` / `which`）整体跳过——这里不关心装了什么。
 */

/** 播种运行与其节点，见 src/seed.ts */
const SEED_RUN_ID = 'run-collab-core';

/** 每个用例建的临时目录，afterEach 统一清掉 */
const tempDirs: string[] = [];
const originalArtifactDir = process.env.AGENT_ARTIFACT_DIR;

interface Fixture {
  app: FastifyInstance;
  /** 与 buildApp 内部同一个落盘目录 */
  artifacts: ArtifactStore;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-node-queries-'));
  tempDirs.push(root);

  const artifactDir = join(root, 'artifacts');
  // buildApp 构造 ArtifactStore 时读这个变量，必须在它之前设好
  process.env.AGENT_ARTIFACT_DIR = artifactDir;

  const { app } = await buildApp({
    logPath: join(root, 'events.jsonl'),
    catalog: [],
    logger: false,
  });
  await app.ready();

  return { app, artifacts: new ArtifactStore(artifactDir) };
}

afterEach(async () => {
  if (originalArtifactDir === undefined) {
    delete process.env.AGENT_ARTIFACT_DIR;
  } else {
    process.env.AGENT_ARTIFACT_DIR = originalArtifactDir;
  }

  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => {},
      ),
    ),
  );
});

const DIFF = [
  'diff --git a/src/auth/login.ts b/src/auth/login.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth/login.ts',
  '+++ b/src/auth/login.ts',
  '@@ -1,3 +1,4 @@',
  ' export function login() {',
  '+  // 扫码登录',
  '   return null;',
  ' }',
].join('\n');

describe('GET /api/runs/:id/nodes/:nodeId/artifact', () => {
  it('运行不存在时 404，而不是返回空 diff 假装成功', async () => {
    const { app } = await createFixture();

    const response = await app.inject({
      method: 'GET',
      url: '/api/runs/run-ghost/nodes/impl-account/artifact',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'artifact_not_found' });
    // 关键：失败分支不能顺手给出 diff 字段，调用方会把它当成「什么都没改」
    expect(response.json()).not.toHaveProperty('diff');

    await app.close();
  });

  it('节点不存在时同样 404', async () => {
    const { app } = await createFixture();

    const response = await app.inject({
      method: 'GET',
      url: `/api/runs/${SEED_RUN_ID}/nodes/never-existed/artifact`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'artifact_not_found' });

    await app.close();
  });

  it('节点真的写过产物时返回 diff 原文与统计量', async () => {
    const { app, artifacts } = await createFixture();

    // 真的先落盘再请求：接口读的是磁盘上那份文件，不是内存里的字段
    await artifacts.save(SEED_RUN_ID, 'impl-account', {
      diff: DIFF,
      files: ['src/auth/login.ts'],
      bytes: Buffer.byteLength(DIFF, 'utf8'),
      capturedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/runs/${SEED_RUN_ID}/nodes/impl-account/artifact`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      diff: string;
      files: string[];
      bytes: number;
      runId: string;
      nodeId: string;
    };

    // diff 必须原样返回：后端不截断，折叠与截断属于展示层
    expect(body.diff).toBe(DIFF);
    expect(body.diff).toContain('扫码登录');
    expect(body.files).toEqual(['src/auth/login.ts']);
    expect(body.bytes).toBe(Buffer.byteLength(DIFF, 'utf8'));
    expect(body.runId).toBe(SEED_RUN_ID);
    expect(body.nodeId).toBe('impl-account');

    await app.close();
  });

  it('文件列表从 diff 头推出来，多个文件都算上', async () => {
    const { app, artifacts } = await createFixture();

    const multi = [
      'diff --git a/src/auth/login.ts b/src/auth/login.ts',
      '--- a/src/auth/login.ts',
      '+++ b/src/auth/login.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/auth/scan.ts b/src/auth/scan.ts',
      '--- a/src/auth/scan.ts',
      '+++ b/src/auth/scan.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    await artifacts.save(SEED_RUN_ID, 'impl-account', {
      diff: multi,
      files: ['src/auth/login.ts', 'src/auth/scan.ts'],
      bytes: Buffer.byteLength(multi, 'utf8'),
      capturedAt: new Date().toISOString(),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/runs/${SEED_RUN_ID}/nodes/impl-account/artifact`,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { files: string[] }).files).toEqual([
      'src/auth/login.ts',
      'src/auth/scan.ts',
    ]);

    await app.close();
  });
});

describe('GET /api/runs/:id/nodes/:nodeId/events', () => {
  it('只返回该节点的事件', async () => {
    const { app } = await createFixture();

    const response = await app.inject({
      method: 'GET',
      url: `/api/runs/${SEED_RUN_ID}/nodes/impl-account/events`,
    });

    expect(response.statusCode).toBe(200);
    const events = response.json() as Array<{ nodeId?: string; message: string }>;

    expect(events.length).toBeGreaterThan(0);
    // 一条都不能漏出别的节点：这是「看这个节点干了什么」的全部依据
    expect(events.every((event) => event.nodeId === 'impl-account')).toBe(true);
    expect(events.some((event) => event.message.includes('开始执行'))).toBe(true);

    // 别的节点的输出不能因为同一批 derive 结果就串到这里
    expect(
      events.some((event) => event.message.includes('消息一致性审查')),
    ).toBe(false);

    await app.close();
  });

  it('节点没有任何事件时返回空数组，运行不存在时 404', async () => {
    const { app } = await createFixture();

    // seed 里 deliver 节点从未开始，所以它没有任何事件
    const empty = await app.inject({
      method: 'GET',
      url: `/api/runs/${SEED_RUN_ID}/nodes/deliver/events`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/runs/${SEED_RUN_ID}/nodes/never-existed/events`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'node_not_found' });

    const ghostRun = await app.inject({
      method: 'GET',
      url: '/api/runs/run-ghost/nodes/impl-account/events',
    });
    expect(ghostRun.statusCode).toBe(404);
    expect(ghostRun.json()).toEqual({ error: 'node_not_found' });

    await app.close();
  });
});
