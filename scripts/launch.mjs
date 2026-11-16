import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv[2];
if (mode !== 'real' && mode !== 'mock') {
  throw new Error('请选择 real 或 mock 执行模式');
}
const data = join(root, 'data', mode === 'real' ? 'local' : 'demo');
const codex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const pathEntries = [process.env.PATH ?? ''];
if (process.platform === 'darwin' && existsSync(codex)) {
  pathEntries.push(dirname(codex));
}
const child = spawn('pnpm', ['dev'], {
  cwd: root,
  shell: process.platform === 'win32',
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: pathEntries.join(delimiter),
    HOST: '127.0.0.1',
    PORT: '3000',
    AGENT_RUNNER: mode,
    AGENT_WORKSPACE: 'git',
    AGENT_TARGET_DIR: mode === 'real' && process.env.AGENT_TARGET_DIR
      ? process.env.AGENT_TARGET_DIR
      : join(data, 'project'),
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
