import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2];
if (mode !== 'real' && mode !== 'mock') {
  throw new Error('请选择 real 或 mock 执行模式');
}
const data = join(root, 'data', mode === 'real' ? 'local' : 'demo');
const child = spawn('pnpm', ['dev'], {
  cwd: root,
  shell: process.platform === 'win32',
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '3000',
    AGENT_RUNNER: mode,
    AGENT_WORKSPACE: 'git',
    // 不设默认目标目录：目标目录必须由用户在新建运行里显式选择。
    // 给一个 data/local/project 之类的默认值，会让成果悄悄落在没人打算用的
    // 地方。外部可以用 AGENT_TARGET_DIR 覆盖（运维/脚本场景）。
    AGENT_TARGET_DIR: process.env.AGENT_TARGET_DIR,
    AGENT_WORKTREE_DIR: join(data, 'worktrees'),
    AGENT_ARTIFACT_DIR: join(data, 'artifacts'),
    EVENT_LOG_PATH: join(data, 'journal', 'events.jsonl'),
    LOCK_PATH: join(data, 'journal', 'orchestrator.lock'),
    PROCESS_DIR: join(data, 'processes'),
  },
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => { process.exitCode = code ?? 1; });
