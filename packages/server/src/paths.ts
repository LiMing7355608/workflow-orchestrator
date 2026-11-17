import { existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 数据目录的解析规则，**一处定义**。
 *
 * 之前 `main.ts` 与 `app.ts` 各写了一份：两处必须指向同一棵树，否则锁在一处、
 * journal 在另一处，双实例互不设防，而且这种不一致只会在「跑了很久才发现
 * 历史没了」的时候暴露。
 *
 * 三种运行形态，优先级从高到低：
 *
 * 1. `AGENT_DATA_DIR` —— 显式覆盖。多实例分家、测试隔离、用户想放大盘上都靠它。
 * 2. **打包成可执行文件之后** —— 数据不能跟着「仓库」走，因为那时候没有仓库：
 *    `import.meta.url` 指向 exe 内部的虚拟路径（pkg / SEA）或临时解压目录
 *    （Bun compile），`../../../` 会溯源到毫无意义的地方。此时退到 exe 同级
 *    目录（便携式），不可写则退 `%APPDATA%` 一类的用户目录。
 * 3. **从源码/构建产物运行** —— 仓库根下的 `data/`。从模块自身位置溯源，而不是
 *    取 `process.cwd()`：换个目录启动 `node packages/server/dist/main.js` 也该
 *    指向同一份历史。
 */

/** 是否运行在被打包出来的单文件里。 */
function isPackaged(): boolean {
  // 各种打包器的标记。都不认的时候用 url 形态兜底。
  const proc = process as unknown as { pkg?: unknown; isBun?: boolean; isSEA?: boolean };
  if (proc.pkg !== undefined || proc.isSEA === true) {
    return true;
  }
  /**
   * 只看 `import.meta.url` 的形态最可靠：
   * - 正常运行：`file:///F:/.../main.js`
   * - pkg / SEA：`file:///snapshot/...`、`file:///C:/.../app.exe`（exe 自身）
   * - Bun compile：虚拟路径，甚至不是 `file:` 协议
   */
  const url = import.meta.url;
  if (!url.startsWith('file:')) {
    return true;
  }
  return url.includes('/snapshot/') || /\.exe(\?|$)/i.test(url);
}

/** 能在这里创建文件吗。用来在便携式与用户目录之间做决定。 */
function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 仓库根：从当前模块往上溯源三级（`packages/server/{src,dist}` → 仓库根）。 */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL('../../../', import.meta.url)));
}

/** 编排器的数据根目录。三种形态见文件头注释。 */
export function resolveDataDir(): string {
  const override = process.env.AGENT_DATA_DIR?.trim();
  if (override) {
    return resolve(override);
  }

  if (isPackaged()) {
    /**
     * 便携式优先：exe 旁边放数据，拷走整个文件夹就是带走全部历史。
     * 装进 `Program Files` 之类只读位置时退到用户目录——那里一定要能写，
     * 否则第一次启动就会在创建 journal 时崩掉，而那是最难解释的一种失败。
     */
    const portable = resolve(dirname(process.execPath), 'data');
    if (!existsSync(portable)) {
      try {
        return portable;
      } catch {
        // 下面还有兜底
      }
    }
    if (isWritable(portable) || isWritable(dirname(portable))) {
      return portable;
    }
    return resolve(homedir(), '.workflow-orchestrator', 'data');
  }

  return resolve(repoRoot(), 'data');
}
