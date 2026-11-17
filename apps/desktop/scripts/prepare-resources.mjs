import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

/**
 * 把桌面应用要带走的产物铺到 `resources/` 下。
 *
 * 铺什么、为什么：
 *
 * - `resources/server/dist`：server 的构建产物。**依赖没有被打包进 dist**
 *   （tsup 只编自己的源码，`fastify` / `zod` 这些仍是外部 import），所以还得带
 *   node_modules，否则启动时第一句 import 就崩。
 * - `resources/server/node_modules`：生产依赖树，用 `pnpm deploy --prod` 生成。
 *   直接拷仓库根那份是不行的——里面有 devDependencies 和别的 workspace 包。
 * - `resources/web`：前端构建产物。server 用 `@fastify/static` 托管它。
 *
 * 不做的事：不装 Electron 本身、不签名、不做下载器。这个脚本只负责「让打出来的
 * 包能跑起来」。
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '../..');
const resources = join(desktopRoot, 'resources');

function log(message) {
  console.log(`[prepare-resources] ${message}`);
}

function fail(message) {
  console.error(`[prepare-resources] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr ?? '') : '';
    fail(`${command} ${args.join(' ')} 失败${detail ? `：${detail.trim()}` : ''}`);
  }
  return result;
}

/** 1. 前置检查：server 与 web 必须先构建过。 */
const serverDist = join(repoRoot, 'packages/server/dist');
const webDist = join(repoRoot, 'packages/web/dist');
if (!existsSync(join(serverDist, 'main.js'))) {
  fail('缺少 packages/server/dist/main.js，先跑 pnpm -r build');
}
if (!existsSync(join(webDist, 'index.html'))) {
  fail('缺少 packages/web/dist/index.html，先跑 pnpm -r build');
}

rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });

/** 2. 生产依赖树。deploy 会连源码一起铺，所以先落到临时目录再挑。 */
// 必须落在仓库内并传**相对**路径：pnpm deploy 在 --filter 下会把目标拼到包子目录后面，// 绝对路径会被当成相对段再拼一次，得到一个 packages/server\C:\... 这种畸形路径。
const staging = join(repoRoot, '.tmp', 'deploy');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

log('生成服务端生产依赖（pnpm deploy）…');
run('pnpm', [
  '--filter',
  '@orchestrator/server',
  'deploy',
  staging,
  '--prod',
  '--legacy',
]);

const targetServer = join(resources, 'server');
mkdirSync(targetServer, { recursive: true });

for (const entry of ['dist', 'node_modules']) {
  const from = join(staging, entry);
  if (!existsSync(from)) {
    fail(`deploy 结果里没有 ${entry}，打包会缺东西`);
  }
  log(`拷贝 ${entry}`);
  cpSync(from, join(targetServer, entry), { recursive: true });
}

/**
 * package.json 要改写。
 *
 * deploy 出来那份的 `main` 指向 `dist/main.js`（正确），但 `scripts` /
 * `devDependencies` / workspace 协议引用对运行时毫无意义，留着只会让人以为
 * 这些东西在包里还能用。只保留运行必需的三项。
 */
const stagedPkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'));
writeFileSync(
  join(targetServer, 'package.json'),
  `${JSON.stringify(
    {
      name: stagedPkg.name,
      version: stagedPkg.version,
      // 没有这行，`node <dir>` 找不到入口；Electron 那边是显式指 dist/main.js，
      // 但留一个正确的 main 让人能直接 `node resources/server` 排查
      main: 'dist/main.js',
      type: stagedPkg.type ?? 'module',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

/** 3. 前端产物。 */
log('拷贝 web');
cpSync(webDist, join(resources, 'web'), { recursive: true });

/** 4. 清场。 */
rmSync(staging, { recursive: true, force: true });

/**
 * 5. 自检：目录结构对了不等于能跑。这里只验证「入口文件存在且能解析到依赖」，
 *    真正的启动验证交给 `electron-forge package` 之后的实跑。
 */
const checks = [
  [join(targetServer, 'dist/main.js'), 'server 入口'],
  [join(targetServer, 'node_modules/fastify/package.json'), 'fastify 依赖'],
  [join(targetServer, 'node_modules/@fastify/static/package.json'), '@fastify/static 依赖'],
  [join(targetServer, 'node_modules/zod/package.json'), 'zod 依赖'],
  [join(resources, 'web/index.html'), '前端入口'],
];
for (const [path, label] of checks) {
  if (!existsSync(path)) {
    fail(`自检失败：缺 ${label}（${path}）`);
  }
}

const size = (dir) => {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        total += statSync(full).size;
      }
    }
  };
  walk(dir);
  return total;
};

log(`完成。server ${(size(targetServer) / 1024 / 1024).toFixed(1)} MB，web ${(size(join(resources, 'web')) / 1024 / 1024).toFixed(1)} MB`);
