import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app';

it('生产静态服务仅对页面导航回送 SPA 入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orchestrator-static-'));
  const webRoot = join(root, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Workflow Orchestrator</title>');
  await writeFile(join(webRoot, 'assets', 'index.js'), 'console.log("ready");');

  try {
    const { app } = await buildApp({ logPath: join(root, 'events.jsonl'), webRoot, catalog: [], logger: false });
    try {
      const headers = { accept: 'text/html,application/xhtml+xml' };
      const page = await app.inject({ url: '/runs/example?view=events', headers });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<title>Workflow Orchestrator</title>');

      const asset = await app.inject({ url: '/assets/index.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('console.log');

      for (const url of ['/assets/missing.js?v=1', '/assets/missing', '/favicon.ico', '/api/missing']) {
        const missing = await app.inject({ url, headers });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: 'not_found' });
      }

      const fetch = await app.inject({ url: '/runs/example', headers: { accept: '*/*' } });
      expect(fetch.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
