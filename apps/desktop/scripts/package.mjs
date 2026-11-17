import { packager } from '@electron/packager';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 打包，但绕开 `electron-forge`。
 *
 * 为什么不用 forge：它在启动时检查「用 pnpm 就必须 `node-linker=hoisted` 或
 * 显式配置 hoist-pattern」，而那个检查读的是 `pnpm config get`——pnpm 10 对
 * 没有显式写进配置树的项一律返回 `undefined`，哪怕 `.modules.yaml` 里
 * `nodeLinker: hoisted` 已经生效。直接调 forge 底层的 `@electron/packager`
 * 没有这层检查，产物是一样的（forge 就是它的封装）。
 *
 * 走 forge 官方的 `make`（做 zip / 安装器）才需要它，那一步可以等真正要出
 * 安装包时再解决——先把「打出来的目录能跑」这件事验证掉。
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');

const appPaths = await packager({
  dir: desktopRoot,
  out: join(desktopRoot, 'out'),
  name: 'WorkflowOrchestrator',
  executableName: 'workflow-orchestrator',
  platform: process.platform,
  arch: process.arch,
  asar: true,
  overwrite: true,
  /**
   * server 与 web 必须留在 asar 外面。
   *
   * server 要作为独立 Node 进程被 spawn（`process.execPath <entry>`），asar 是
   * 只读虚拟归档，没有真实路径可指；web 由 server 用 `@fastify/static` 读，同理。
   */
  extraResource: [
    join(desktopRoot, 'resources/server'),
    join(desktopRoot, 'resources/web'),
  ],
  /**
   * 只保留运行时需要的东西。
   *
   * 默认会把整个包目录（含 src、scripts、resources、tsconfig）都塞进 asar。
   * 这些对运行没有用，但会让调试时 `app.asar` 里的内容看起来像源码仓库。
   */
  ignore: [
    /^\/src($|\/)/,
    /^\/scripts($|\/)/,
    /^\/resources($|\/)/,
    /^\/out($|\/)/,
    /^\/forge\.config\.ts$/,
    /^\/tsconfig\.json$/,
    /^\/\.npmrc$/,
    /^\/node_modules($|\/)/,
  ],
});

console.log('[package] 完成：');
for (const path of appPaths) {
  console.log(`  ${path}`);
}
