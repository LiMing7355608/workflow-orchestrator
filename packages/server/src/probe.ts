import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAvailability, AgentProfile } from '@orchestrator/core';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeResult {
  installed: boolean;
  version?: string;
  /** 解析到的实际文件路径，便于界面排查 */
  path?: string;
}

/**
 * 用系统的路径解析器定位可执行文件。
 *
 * 不能直接 `execFile(bin)`：Windows 上 npm 装出来的是 `.ps1` / `.cmd` shim，
 * 不经过 shell 根本解析不了，会把装好的 CLI 误判为未安装。
 * `where` / `which` 走的是与用户终端一致的解析规则，是「装没装」的权威判据。
 */
async function locateBinary(bin: string): Promise<string | undefined> {
  const tool = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(tool, [bin], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
  } catch {
    return undefined;
  }
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

/**
 * 只为了拿版本号。参数永远是固定的 `--version`，不含任何用户输入，
 * 所以经过 shell 不会带来注入面；这也正是 shim 唯一能跑起来的方式。
 */
async function readVersion(
  path: string,
): Promise<string | undefined> {
  const ext = extensionOf(path);
  const options = { timeout: PROBE_TIMEOUT_MS, windowsHide: true };

  try {
    let stdout = '';
    let stderr = '';
    if (ext === '.ps1') {
      ({ stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', path, '--version'],
        options,
      ));
    } else if (ext === '.cmd' || ext === '.bat') {
      ({ stdout, stderr } = await execFileAsync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/c', path, '--version'],
        options,
      ));
    } else {
      ({ stdout, stderr } = await execFileAsync(path, ['--version'], options));
    }
    return extractVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    // 文件在、但 --version 行为不同：仍算已安装，只是版本未知
    const err = error as { stdout?: string; stderr?: string };
    return extractVersion(`${err.stdout ?? ''}\n${err.stderr ?? ''}`);
  }
}

export async function probeBinary(bin: string): Promise<ProbeResult> {
  const resolved = await locateBinary(bin);

  if (!resolved) {
    // 路径解析失败时再直接试一次，兼容解析器不在 PATH 的极端环境
    try {
      const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      return { installed: true, version: extractVersion(`${stdout}\n${stderr}`) };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { installed: false };
      }
      return { installed: true };
    }
  }

  return {
    installed: true,
    version: await readVersion(resolved),
    path: resolved,
  };
}

function extractVersion(text: string): string | undefined {
  return text.match(/\d+\.\d+\.\d+[\w.\-+]*/)?.[0];
}

/**
 * 把探测结果合并进目录。
 *
 * `ready` 是「本机真跑通过」的人工标注，探测不能凭空产生它，
 * 只能把不存在的事实降级成 `missing`。这样界面上的「可直接调用」
 * 始终代表有人真的验证过，而不是「文件存在」。
 */
export function mergeProbe(
  profile: AgentProfile,
  probe: ProbeResult,
): AgentProfile {
  if (!probe.installed) {
    return { ...profile, availability: 'missing', version: undefined };
  }
  const availability: AgentAvailability =
    profile.availability === 'ready' ? 'ready' : 'installed';
  return {
    ...profile,
    availability,
    version: probe.version ?? profile.version,
  };
}

/** 并行探测整份目录。单条超时不会拖住整体。 */
export async function probeCatalog(
  catalog: AgentProfile[],
): Promise<AgentProfile[]> {
  return Promise.all(
    catalog.map(async (profile) => {
      const probe = await probeBinary(profile.launch.bin);
      return mergeProbe(profile, probe);
    }),
  );
}
