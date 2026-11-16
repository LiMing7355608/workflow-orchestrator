import { Boxes, Clock, Plus, Search, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RunRecordRow } from '../components/runs/RunRecordRow';
import { Button, buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import { seedRuns } from '../data/seed';
import { fetchRuns } from '../lib/api';
import { useApiResource, useLiveRefresh } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';
import type { RunStatus } from '../types/workflow';

type StatusFilter = 'all' | RunStatus;
type SortKey = 'updated' | 'progress' | 'nodes';
type DateGroup = '今天' | '昨天' | '更早';

const sortLabels: Record<SortKey, string> = {
  updated: '最近更新',
  progress: '进度从高到低',
  nodes: '节点数从多到少',
};

function getDateGroup(iso: string): DateGroup {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const time = new Date(iso).getTime();

  if (time >= startOfToday) {
    return '今天';
  }
  if (time >= startOfYesterday) {
    return '昨天';
  }
  return '更早';
}

export function RunRecordsPage() {
  usePageTitle('运行记录');

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('updated');

  const { data: runs, source, reload } = useApiResource(fetchRuns, seedRuns);
  useLiveRefresh(source === 'live', reload);

  const counts = useMemo(
    () => ({
      all: runs.length,
      running: runs.filter((run) => run.status === 'running').length,
      waiting: runs.filter((run) => run.status === 'waiting_for_boss').length,
      completed: runs.filter((run) => run.status === 'completed').length,
      paused: runs.filter((run) => run.status === 'paused').length,
    }),
    [runs],
  );

  const statusOptions: Array<{ value: StatusFilter; label: string }> = [
    { value: 'all', label: `全部 ${counts.all}` },
    { value: 'running', label: `运行中 ${counts.running}` },
    { value: 'waiting_for_boss', label: `待你处理 ${counts.waiting}` },
    { value: 'completed', label: `已完成 ${counts.completed}` },
    { value: 'paused', label: `已暂停 ${counts.paused}` },
  ];

  const filteredRuns = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const matched = runs.filter((run) => {
      const matchesStatus = status === 'all' || run.status === status;
      const matchesQuery =
        !keyword ||
        `${run.title} ${run.summary}`.toLowerCase().includes(keyword);
      return matchesStatus && matchesQuery;
    });

    return [...matched].sort((a, b) => {
      if (sort === 'progress') {
        return b.progress - a.progress;
      }
      if (sort === 'nodes') {
        return b.nodeCount - a.nodeCount;
      }
      return (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
    });
  }, [runs, query, status, sort]);

  const groups = useMemo(() => {
    const order: DateGroup[] = ['今天', '昨天', '更早'];
    return order
      .map((label) => ({
        label,
        runs: filteredRuns.filter((run) => getDateGroup(run.updatedAt) === label),
      }))
      .filter((group) => group.runs.length > 0);
  }, [filteredRuns]);

  function resetFilters() {
    setQuery('');
    setStatus('all');
    setSort('updated');
  }

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            SE Workflow Studio
          </div>
          <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.025em] text-ink max-[700px]:text-[24px]">
            运行记录
          </h1>
          <p className="mt-1.5 text-[13px] text-muted">
            查看所有设计规格的分解、编排与执行历史。
          </p>
        </div>

        <Link
          to="/new"
          className={buttonStyles({ className: 'max-[700px]:hidden' })}
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          新建运行
        </Link>
      </div>

      <Card className="mt-6 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-[240px] max-[700px]:w-full">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-passive"
              strokeWidth={1.8}
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索运行"
              aria-label="搜索运行"
              className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-[12px] text-ink placeholder:text-passive transition-colors focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          </div>

          <div className="max-w-full overflow-x-auto">
            <Segmented
              options={statusOptions}
              value={status}
              onChange={setStatus}
              ariaLabel="按状态筛选运行"
            />
          </div>

          <div className="ml-auto flex items-center gap-2 max-[700px]:ml-0">
            <label htmlFor="run-sort" className="text-[10px] text-passive">
              排序
            </label>
            <select
              id="run-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className="h-8 rounded-lg border border-line bg-surface px-2.5 text-[11px] text-ink transition-colors focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
            >
              {(Object.keys(sortLabels) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {sortLabels[key]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
        <span>共 {filteredRuns.length} 个运行</span>
        <span className="text-passive">
          {filteredRuns.length === runs.length ? '全部记录' : '已筛选'}
        </span>
      </div>

      <Card className="mt-2 overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)_96px_96px_150px_64px_88px_20px] items-center gap-4 border-b border-line bg-subtle/30 px-5 py-2 text-[10px] text-passive max-[1100px]:grid-cols-[minmax(0,1fr)_96px_150px_64px_88px_20px] max-[900px]:hidden">
          <span>运行</span>
          <span>状态</span>
          <span className="max-[1100px]:hidden">阶段</span>
          <span>进度</span>
          <span className="flex items-center gap-1.5">
            <Boxes className="h-3.5 w-3.5" strokeWidth={1.8} />
            节点
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" strokeWidth={1.8} />
            更新时间
          </span>
          <span />
        </div>

        {groups.length > 0 ? (
          groups.map((group) => (
            <div key={group.label}>
              <div className="flex items-center gap-2 border-b border-line bg-subtle/30 px-5 py-1.5 text-[10px] font-medium text-muted">
                {group.label}
                <span className="text-passive">· {group.runs.length}</span>
              </div>
              <div className="divide-y divide-line">
                {group.runs.map((run) => (
                  <RunRecordRow key={run.id} run={run} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <EmptyState
            icon={SearchX}
            title="没有匹配的运行"
            description="调整搜索关键词或状态筛选后再试。"
            action={
              <Button variant="secondary" size="sm" onClick={resetFilters}>
                清除筛选
              </Button>
            }
          />
        )}
      </Card>
    </div>
  );
}
