import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { isWorkspaceFilePath, type SavedTaskFiles, type TaskDeliverable } from '@orchestrator/core';
import { extract } from 'tar';
import { isMissing, projectRunPath, writeAtomic } from './project-files.js';

const git = promisify(execFile);
const FILES_SHOWN = 100;

async function checkedEntry(root: string, path: string): Promise<{ path: string; regular: boolean } | undefined> {
  if (!isWorkspaceFilePath(path)) throw new Error('无效的交付文件路径。');
  const parts = path.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (index === parts.length - 1) return { path: current, regular: info.isFile() };
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
  }
  return undefined;
}

async function saveBlob(root: string, commit: string, path: string, target: string): Promise<void> {
  const child = spawn('git', ['cat-file', 'blob', commit + ':' + path], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('无法读取已提交的文件。' + path)));
  });
  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(target, { flags: 'wx' }), { signal: AbortSignal.timeout(120_000) }),
      exited,
    ]);
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  }
}

export async function saveTaskDelivery(input: {
  root: string;
  runId: string;
  nodeId: string;
  cwd: string;
  commit?: string;
  deliverables: TaskDeliverable[];
}): Promise<SavedTaskFiles> {
  const { root, runId, nodeId, cwd, commit, deliverables } = input;
  if (commit && !/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('交付提交编号无效。');
  if (deliverables.some(({ path }) => !isWorkspaceFilePath(path))) throw new Error('无效的交付文件路径。');

  const targets = new Map<string, boolean>();
  if (commit) {
    const { stdout } = await git('git', ['--literal-pathspecs', 'ls-tree', '-r', '-t', '-z', commit, '--', ...deliverables.map(({ path }) => path)], {
      cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
    for (const line of stdout.split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      targets.set(line.slice(tab + 1), /^100(?:644|755) blob /.test(line.slice(0, tab)));
    }
  }

  const revision = randomUUID();
  const target = await projectRunPath(root, runId, 'deliveries', nodeId, revision);
  const stage = await projectRunPath(root, runId, 'deliveries', nodeId, revision + '.tmp');
  await mkdir(stage, { recursive: true });
  try {
    const files: SavedTaskFiles['files'] = [];
    const removed: string[] = [];
    for (const item of deliverables) {
      const source = await checkedEntry(cwd, item.path);
      if (item.kind === 'remove') {
        if (source || targets.has(item.path)) throw new Error('应删除的文件仍在工程内。' + item.path);
        removed.push(item.path);
        continue;
      }
      if (!source?.regular || commit && targets.get(item.path) !== true) {
        throw new Error('未找到已写入的交付文件。' + item.path);
      }
      const out = join(stage, ...item.path.split('/'));
      await mkdir(dirname(out), { recursive: true });
      if (commit) await saveBlob(root, commit, item.path, out);
      else await copyFile(source.path, out);
      files.push({ path: item.path, bytes: (await lstat(out)).size });
    }
    await rename(stage, target);
    return { revision, files, fileCount: files.length, removed };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function listFiles(root: string): Promise<Pick<SavedTaskFiles, 'files' | 'fileCount'>> {
  const files: SavedTaskFiles['files'] = [];
  let fileCount = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, path + '/');
      else if (entry.isFile()) {
        fileCount += 1;
        if (files.length < FILES_SHOWN) files.push({ path, bytes: (await lstat(absolute)).size });
      }
    }
  }
  await walk(root, '');
  return { files, fileCount };
}

export async function saveIntegratedDelivery(
  root: string, runId: string, commit: string, planned: Iterable<TaskDeliverable>,
): Promise<SavedTaskFiles> {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('无法确定集成提交。');
  const revision = randomUUID();
  const outputDir = await projectRunPath(root, runId, 'output');
  const target = await projectRunPath(root, runId, 'output', revision);
  const stage = await projectRunPath(root, runId, 'output', revision + '.tmp');
  const generatedZip = await projectRunPath(root, runId, revision + '.zip.tmp');
  const versionedZip = await projectRunPath(root, runId, 'output', revision + '.zip');
  const tar = await projectRunPath(root, runId, revision + '.tar.tmp');
  const zip = await projectRunPath(root, runId, 'output.zip');
  await mkdir(stage, { recursive: true });
  const opts = { cwd: root, windowsHide: true, timeout: 120_000 };
  try {
    await git('git', ['archive', '--format=tar', '-o', tar, commit], opts);
    await extract({
      cwd: stage, file: tar, strict: true,
      filter: (path, entry) =>
        isWorkspaceFilePath(path.replace(/\/$/, '')) &&
        'type' in entry && (entry.type === 'File' || entry.type === 'Directory'),
    });
    for (const item of planned) {
      const saved = await checkedEntry(stage, item.path);
      if (item.kind === 'remove' ? saved : !saved?.regular) {
        throw new Error('集成交付未满足文件要求。' + item.path);
      }
    }
    const listing = await listFiles(stage);
    await git('git', ['archive', '--format=zip', '-o', generatedZip, commit], opts);
    await rename(stage, target);
    await rename(generatedZip, versionedZip);
    const alias = await projectRunPath(root, runId, revision + '.alias.tmp');
    try {
      await copyFile(versionedZip, alias);
      await rename(alias, zip);
    } finally {
      await rm(alias, { force: true });
    }
    await writeAtomic(join(outputDir, 'current.json'), JSON.stringify({ revision, commit, ...listing }, null, 2) + '\n');
    return { revision, ...listing, removed: [] };
  } finally {
    await Promise.all([
      rm(stage, { recursive: true, force: true }),
      rm(generatedZip, { force: true }),
      rm(tar, { force: true }),
    ]);
  }
}

export async function deliveryFile(
  root: string, runId: string, nodeId: string, path: string, delivery: SavedTaskFiles, integrated: boolean,
): Promise<string | undefined> {
  if (!isWorkspaceFilePath(path)) return undefined;
  const directory = integrated
    ? await projectRunPath(root, runId, 'output', delivery.revision)
    : await projectRunPath(root, runId, 'deliveries', nodeId, delivery.revision);
  const file = await checkedEntry(directory, path);
  return file?.regular ? file.path : undefined;
}

export function attachment(filename: string): string {
  return 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(basename(filename)).replace(/['()*]/g, (value) =>
    '%' + value.charCodeAt(0).toString(16).toUpperCase(),
  );
}
