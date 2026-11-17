import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

/**
 * 桌面壳 = **一个守护进程 + 一个窗口**。
 *
 * 为什么不在 Electron 主进程里直接 `buildApp()`：那是把 HTTP 服务塞进渲染宿主
 * 同一个进程。server 一旦卡住（长事务、同步解析、死锁），整个窗口跟着白屏，
 * 连「重启服务」的菜单都点不动。独立子进程还有个好处——它崩了能得到退出码，
 * 而不是把一个半死的主进程留在那里。
 *
 * 代价是启动方要自己找到「服务起在哪个端口」。约定是 `running.json`：
 * server 落真实地址，这里轮询读。比从 stdout 里抠端口可靠得多。
 */

/** 开发态与打包态下 server 入口的位置不同。 */
function resolveServerEntry(): string {
  // 打包后由 electron-builder/forge 的 extraResource 铺到 resources/server
  const packaged = join(process.resourcesPath, 'server', 'main.js');
  if (existsSync(packaged)) {
    return packaged;
  }
  // 开发态：仓库里的构建产物（apps/desktop/dist → 仓库根 → packages/server/dist）
  return resolve(__dirname, '../../../packages/server/dist/main.js');
}

/**
 * 应用名要在 `app.getPath('userData')` **第一次被读之前**定下来。
 *
 * 默认取 `package.json` 的 `name`，而那是 `@orchestrator/desktop`——Electron
 * 会把它原样铺成目录名，于是数据落到 `%APPDATA%\@orchestrator\desktop\`。
 * 一个带 `@` 和作用域的目录名对用户毫无意义，也容易被误当成某个 npm 缓存。
 */
app.setName('WorkflowOrchestrator');

/** 数据根：桌面版用用户目录，免得装到只读位置（Program Files）就没法写。 */
function resolveDataDir(): string {
  return join(app.getPath('userData'), 'data');
}

function runningFilePath(): string {
  return join(resolveDataDir(), 'running.json');
}

/** 等 `running.json` 出现且可用。返回服务 URL。 */
async function waitForServer(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '超时';
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(runningFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as { url?: unknown; pid?: unknown };
      if (typeof parsed.url === 'string') {
        /**
         * 顺手确认这个 pid 还活着。
         *
         * `running.json` 是上一轮崩溃留下的陈旧文件时，URL 看着完全正常，
         * 但那个端口早就没人听了——直接加载会得到一个白窗口，而这比报错更难
         * 诊断。所以先发 0 号信号探活。
         */
        const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
        if (pid > 0 && !isAlive(pid)) {
          lastError = '运行地址文件来自已退出的进程';
        } else {
          return parsed.url;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`编排器服务没有在 ${timeoutMs}ms 内就绪：${lastError}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let serverProcess: ChildProcess | undefined;
/** 主动退出中：用来压掉子进程非零退出时的错误弹窗。 */
let quittingOnPurpose = false;
let mainWindow: BrowserWindow | undefined;

/**
 * 启动 server 子进程。
 *
 * 关键是 `ELECTRON_RUN_AS_NODE`：用 Electron 自带的 Node 跑它，用户机器上
 * 不需要另外装 Node。这也是参考实现在桌面版里普遍采用的办法——把运行时自带，
 * 而不是指望 PATH。
 */
function startServer(): ChildProcess {
  const entry = resolveServerEntry();
  if (!existsSync(entry)) {
    throw new Error(
      `找不到 server 入口：${entry}\n先跑一次 pnpm -r build，或者在打包配置里补上 server 产物`,
    );
  }

  const child = spawn(process.execPath, [entry], {
    cwd: dirname(entry),
    env: {
      ...process.env,
      // 让 Electron 以纯 Node 形态执行这个子进程
      ELECTRON_RUN_AS_NODE: '1',
      // 端口交给操作系统分配：不会和 Web 版、也不会和别的实例撞号
      PORT: '0',
      HOST: '127.0.0.1',
      AGENT_DATA_DIR: resolveDataDir(),
      // 子进程的日志不该混进窗口；不设 LOG_LEVEL 时默认 info 足够排障
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // 子进程的输出必须有人接：pipe 满了会把它阻塞住
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[server] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`);
  });
  child.on('exit', (code, signal) => {
    process.stdout.write(`[server] 退出 code=${String(code)} signal=${String(signal)}\n`);
    serverProcess = undefined;
    // 服务没了，窗口留着也没意义：告诉用户发生了什么，而不是让他对着白屏
    if (code !== 0 && code !== null && !quittingOnPurpose) {
      void dialog.showMessageBox({
        type: 'error',
        title: '编排器服务已退出',
        message: `本地服务进程退出（code ${code}）。`,
        detail: '重新打开应用会再起一次。如果反复退出，看终端里的 [server] 日志。',
      });
    }
  });

  return child;
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Workflow Orchestrator',
    backgroundColor: '#0b0f14',
    webPreferences: {
      // 渲染进程只跑我们自己的 Web 应用，不需要 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  // 外链一律交给系统浏览器：应用窗口里不该能导航到任意站点
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  void mainWindow.loadURL(url);
}

/** 目录选择走系统对话框：Web 版那套 PowerShell 弹窗在桌面版里是多余的。 */
ipcMain.handle('orchestrator:pickDirectory', async () => {
  if (!mainWindow) {
    return { picked: false, path: '' };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Agent 干活的目标目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  const first = result.filePaths[0];
  if (result.canceled || first === undefined) {
    return { picked: false, path: '' };
  }
  return { picked: true, path: first };
});

// 单实例：第二次启动只把已有窗口提到前面，不再起一份服务
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    try {
      serverProcess = startServer();
      const url = await waitForServer(30_000);
      createWindow(url);
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        title: '启动失败',
        message: error instanceof Error ? error.message : String(error),
      });
      app.quit();
    }

    app.on('activate', () => {
      // macOS：点 dock 图标且没窗口时重开一个
      if (BrowserWindow.getAllWindows().length === 0 && mainWindow === undefined) {
        void waitForServer(10_000)
          .then(createWindow)
          .catch(() => {});
      }
    });
  });
}

/**
 * 关停顺序：先让 server 自己退出（它会按既定顺序断 HTTP、清登记、放锁），
 * 等不到再强杀。
 *
 * 反过来先杀进程会留下没释放的锁与半截 journal，下一次启动就得靠人工删锁文件。
 */
async function shutdown(): Promise<void> {
  const child = serverProcess;
  if (!child || child.killed) {
    return;
  }
  serverProcess = undefined;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已经没了
      }
      done();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

app.on('window-all-closed', () => {
  // macOS 惯例是窗口关掉应用不退；但我们的服务跟着窗口走，退了才不留孤儿
  if (process.platform !== 'darwin') {
    void shutdown().then(() => app.quit());
  }
});

app.on('before-quit', (event) => {
  if (serverProcess) {
    event.preventDefault();
    quittingOnPurpose = true;
    void shutdown().then(() => app.quit());
  }
});
