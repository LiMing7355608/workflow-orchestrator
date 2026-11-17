import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

/**
 * 打包配置。
 *
 * 三件事值得说明：
 *
 * 1. **server 产物走 `extraResource`**，不进 asar。它要作为一个独立 Node 进程
 *    被 spawn，塞在 asar 里根本没有真实路径可指——asar 是只读的虚拟归档，
 *    `process.execPath <entry>` 拿不到它。
 * 2. **Web 产物同理**，走 `extraResource`，由 server 自己当静态资源发出去
 *    （server 现在就负责这件事，桌面壳不需要重新实现一遍）。
 * 3. **fuses 关闭 `RunAsNode` 之外的危险项**，但 `RunAsNode` 本身必须保留
 *    ——我们正是靠 `ELECTRON_RUN_AS_NODE=1` 用它跑 server 子进程的。
 */
const config = {
  packagerConfig: {
    name: 'WorkflowOrchestrator',
    executableName: 'workflow-orchestrator',
    asar: true,
    extraResource: [
      // 由根脚本在打包前铺到这里：server 的 dist + web 的 dist + 生产依赖
      './resources/server',
      './resources/web',
    ],
    // Agent 是外部 CLI，不随应用分发；这里只忽略明显不需要的东西
    ignore: [/^\/src(\/|$)/, /^\/resources(\/|$)/, /^\/node_modules(\/|$)/],
  },
  makers: [
    // zip 在两个平台上都能用，且不需要额外工具链
    new MakerZIP({}, ['darwin', 'win32']),
  ],
  plugins: [
    // 有原生模块时必须解包：asar 里加载不了 .node
    new AutoUnpackNativesPlugin({}),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config as unknown as ForgeConfig;
