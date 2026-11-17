import { contextBridge, ipcRenderer } from 'electron';

/**
 * 渲染进程能用到的东西，只有**明确列在这里**的这些。
 *
 * `contextIsolation: true` + 白名单式桥接，是为了让 Web 应用即使被注入了
 * 第三方脚本，也拿不到 Node 能力。当前只需要一件事：用系统对话框选目录
 * ——Web 版那套 PowerShell 弹窗在桌面版里既慢又难看。
 */
const bridge = {
  /** 是否是桌面壳。前端据此决定「浏览…」按钮走哪个实现。 */
  isDesktop: true as const,

  /**
   * 打开系统目录选择框。
   *
   * 返回结构与 HTTP 版 `/api/fs/pick-directory` 一致（`{ picked, path }`），
   * 前端不用为两条路写两套分支——这是刻意的：同一份 UI 在浏览器和桌面里
   * 行为一样，只有「谁来弹窗」不同。
   */
  pickDirectory: (): Promise<{ picked: boolean; path: string }> =>
    ipcRenderer.invoke('orchestrator:pickDirectory') as Promise<{
      picked: boolean;
      path: string;
    }>,
};

contextBridge.exposeInMainWorld('orchestratorDesktop', bridge);

export type OrchestratorDesktopBridge = typeof bridge;
