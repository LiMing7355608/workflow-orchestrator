import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
 * macOS 额外使用系统 ditto 生成保留 .app 目录结构和符号链接的 ZIP。
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const appName = 'WorkflowOrchestrator';
const extraResources = ['server', 'web'].map((name) => join(desktopRoot, 'resources', name));

function restoreResourceLinks(source, destination) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      restoreResourceLinks(from, to);
    } else if (entry.isSymbolicLink()) {
      unlinkSync(to);
      symlinkSync(readlinkSync(from), to);
    }
  }
}

const appPaths = await packager({
  dir: desktopRoot,
  out: join(desktopRoot, 'out'),
  name: appName,
  executableName: 'workflow-orchestrator',
  platform: process.platform,
  arch: process.arch,
  asar: true,
  overwrite: true,
  // Seal the completed local bundle with an ad hoc signature before archiving.
  ...(process.platform === 'darwin' && {
    // Packager's copy can expand relative links to absolute build-machine paths.
    // Restore them inside the .app before codesign seals the resources.
    afterCopyExtraResources: [
      ({ buildPath }) => {
        const resources = join(buildPath, `${appName}.app`, 'Contents', 'Resources');
        for (const source of extraResources) {
          restoreResourceLinks(source, join(resources, basename(source)));
        }
      },
    ],
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      continueOnError: false,
    },
  }),
  /**
   * server 与 web 必须留在 asar 外面。
   *
   * server 要作为独立 Node 进程被 spawn（`process.execPath <entry>`），asar 是
   * 只读虚拟归档，没有真实路径可指；web 由 server 用 `@fastify/static` 读，同理。
   */
  extraResource: extraResources,
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

if (process.platform === 'darwin') {
  for (const appPath of appPaths) {
    const bundle = join(appPath, `${appName}.app`);
    const archive = join(desktopRoot, 'out', `WorkflowOrchestrator-mac-${process.arch}.zip`);
    const temporaryArchive = `${archive}.tmp`;
    try {
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, temporaryArchive], {
        stdio: 'inherit',
      });
      renameSync(temporaryArchive, archive);
      console.log(`[package] macOS ZIP: ${archive}`);
    } finally {
      rmSync(temporaryArchive, { force: true });
    }
  }
}

console.log('[package] 完成：');
for (const path of appPaths) {
  console.log(`  ${path}`);
}
