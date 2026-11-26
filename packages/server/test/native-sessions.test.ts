import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { removeHarnessSessions } from '../src/native-sessions.js';

it('清理捕获的 Harness 会话，并保留同一目录的其他会话', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workflow-native-')));
  const project = join(root, '--managed-project--');
  const id = 'b0b9dd31-75d8-4725-9e68-e2f94a60c76a';
  const other = '428e851b-4339-47fc-9857-b8ef3004836e';
  const log = 'session.v4.jsonl.zstd';
  try {
    for (const session of [id, other]) {
      await mkdir(join(project, session), { recursive: true });
      await writeFile(join(project, session, log), session);
    }
    expect(await removeHarnessSessions(root, new Set([id, '../' + other]))).toBe(1);
    expect(await removeHarnessSessions(root, new Set([id]))).toBe(0);
    expect(await readFile(join(project, other, log), 'utf8')).toBe(other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
