import { Clock3, Download, FileCheck2, Files, GitBranch } from 'lucide-react';
import { formatClock, formatDateTime, formatFileSize } from '../../lib/format';
import type { SavedTaskFiles, TaskDeliverable, WorkflowNode } from '../../types/workflow';

export function nodeTimes(node: WorkflowNode) {
  return [
    { label: node.type === 'approval' ? '发起' : '开始', at: node.startedAt },
    { label: node.status === 'failed' ? '失败' : node.type === 'approval' ? '处理' : '结束', at: node.finishedAt },
    { label: '停止', at: node.interruptedAt },
  ].filter((item): item is { label: string; at: string } => Boolean(item.at));
}

export function NodeTimes({ node, compact = false }: { node: WorkflowNode; compact?: boolean }) {
  const stamps = nodeTimes(node);
  if (stamps.length === 0) return null;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-muted">
    <Clock3 aria-hidden="true" className="size-3 shrink-0" />
    {(compact ? stamps.slice(-1) : stamps).map(({ label, at }) =>
      <time key={label} className="tabular-nums" dateTime={at} title={formatDateTime(at) + ' · ' + formatClock(at)}>
        {label} {formatClock(at)}
      </time>,
    )}
  </div>;
}

interface TaskPlanInfo {
  id: string;
  description: string;
  files: string[];
  dependsOn: string[];
  deliverables?: TaskDeliverable[];
  acceptance?: string[];
  delivery?: SavedTaskFiles;
}

export function TaskBreakdown({
  task, runId, dependencies, description = true, onSelectNode,
}: {
  task: TaskPlanInfo;
  runId: string;
  dependencies: ReadonlyMap<string, string>;
  description?: boolean;
  onSelectNode?: (id: string) => void;
}) {
  const delivery = task.delivery;
  const saved = new Map(delivery?.files.map((file) => [file.path, file]));
  const declared = task.deliverables ?? [];
  const inputs = task.dependsOn.filter((id) => dependencies.has(id));
  const additional = delivery?.files.filter((file) => !declared.some((item) => item.path === file.path)) ?? [];
  const download = (path: string) => '/api/runs/' + encodeURIComponent(runId) + '/nodes/' + encodeURIComponent(task.id) + '/file?' +
    new URLSearchParams({ path, revision: delivery?.revision ?? '' }).toString();

  function fileLink(path: string, bytes: number) {
    return <a href={download(path)} title={'下载 ' + path} className="inline-flex min-w-0 items-baseline gap-1.5 rounded text-accent hover:underline">
      <Download aria-hidden="true" className="size-3 shrink-0 self-center" />
      <span className="break-all font-mono">{path}</span><span className="shrink-0 text-[10px] text-muted">{formatFileSize(bytes)}</span>
    </a>;
  }

  return <div className="space-y-3 text-xs leading-5">
    {description && task.description && <p className="whitespace-pre-wrap break-words text-muted">{task.description}</p>}
    {(declared.length > 0 || additional.length > 0 || delivery) && <div>
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink"><Files className="size-3.5 text-accent" />
        {delivery ? '已落盘文件' : '计划交付'}
        {delivery && <span className="font-normal text-muted">{delivery.fileCount} 个</span>}
      </p>
      <ul className="space-y-1">
        {declared.map((item) => {
          const file = saved.get(item.path);
          return <li key={item.path} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {file ? fileLink(file.path, file.bytes) : <code className="break-all text-ink">{item.path}</code>}
            {item.kind === 'remove' && <span className="shrink-0 text-muted">{delivery?.removed.includes(item.path) ? '已删除' : '计划删除'}</span>}
            {item.description && <span className="text-muted">{item.description}</span>}
          </li>;
        })}
        {additional.map((file) => <li key={file.path}>{fileLink(file.path, file.bytes)}</li>)}
      </ul>
      {delivery && delivery.fileCount > delivery.files.length && <p className="text-[11px] text-muted">其余文件可在交付目录或 ZIP 中查看。</p>}
    </div>}
    {Boolean(task.acceptance?.length) && <div>
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-ink"><FileCheck2 className="size-3.5 text-emerald-700" />验收条件</p>
      <ul className="list-disc space-y-0.5 pl-5 text-muted">{task.acceptance?.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>}
    {inputs.length > 0 && <div className="flex flex-wrap items-center gap-1.5 text-muted">
      <GitBranch className="size-3.5 shrink-0" />依赖
      {inputs.map((id) => onSelectNode
        ? <button key={id} type="button" onClick={() => onSelectNode(id)} className="max-w-full truncate rounded border border-line px-1.5 hover:bg-subtle">{dependencies.get(id)}</button>
        : <span key={id} className="max-w-full truncate rounded border border-line px-1.5">{dependencies.get(id)}</span>,
      )}
    </div>}
    {task.files.length > 0 && <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted">
      改动范围 {task.files.map((file) => <code key={file} className="break-all">{file}</code>)}
    </div>}
  </div>;
}
