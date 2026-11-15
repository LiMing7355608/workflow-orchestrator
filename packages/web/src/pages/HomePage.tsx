import {
  Activity,
  CheckCircle2,
  Hand,
  Plus,
  Search,
  SearchX,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PipelineStrip } from '../components/home/PipelineStrip';
import { RunRow } from '../components/home/RunRow';
import { StatCard } from '../components/home/StatCard';
import { Button, buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { seedRuns } from '../data/seed';
import { usePageTitle } from '../lib/use-page-title';

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
        {title}
      </h2>
      <p className="mt-1 text-[11px] text-muted">{description}</p>
    </div>
  );
}

export function HomePage() {
  usePageTitle('工作台');

  const location = useLocation();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!location.hash) {
      return;
    }
    document
      .querySelector(location.hash)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  const filteredRuns = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return seedRuns;
    }
    return seedRuns.filter((run) =>
      `${run.title} ${run.summary}`.toLowerCase().includes(keyword),
    );
  }, [query]);

  const runningCount = seedRuns.filter(
    (run) => run.status === 'running',
  ).length;
  const waitingCount = seedRuns.filter(
    (run) => run.status === 'waiting_for_boss',
  ).length;
  const completedCount = seedRuns.filter(
    (run) => run.status === 'completed',
  ).length;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
      <section className="flex items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            SE Workflow Studio
          </div>
          <h1 className="mt-2 text-[28px] font-semibold tracking-[-0.025em] text-ink max-[700px]:text-[24px]">
            工作台
          </h1>
          <p className="mt-1.5 max-w-[620px] text-[13px] leading-5 text-muted">
            输入设计规格，由 PM Agent 拆解任务，编排器生成可执行的任务图。
          </p>
        </div>

        <Link
          to="/new"
          className={buttonStyles({ className: 'max-[700px]:hidden' })}
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          新建运行
        </Link>
      </section>

      <PipelineStrip className="mt-6" />

      <section
        className="mt-4 grid grid-cols-3 gap-3 max-[900px]:grid-cols-1"
        aria-label="运行概览"
      >
        <StatCard
          label="运行中"
          value={runningCount}
          hint="正在执行的编排"
          icon={Activity}
          tone="blue"
        />
        <StatCard
          label="待你处理"
          value={waitingCount}
          hint="等待人工决定"
          icon={Hand}
          tone="amber"
        />
        <StatCard
          label="已完成"
          value={completedCount}
          hint="已交付的编排"
          icon={CheckCircle2}
          tone="green"
        />
      </section>

      <section id="runs" className="mt-8 scroll-mt-20">
        <div className="flex items-end justify-between gap-4 max-[700px]:items-start">
          <SectionHeading
            title="最近运行"
            description={`共 ${seedRuns.length} 个运行，按最近更新时间排序。`}
          />
          <div className="relative w-[230px] max-[700px]:w-[160px]">
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
        </div>

        <Card className="mt-3 overflow-hidden">
          {filteredRuns.length > 0 ? (
            <div className="divide-y divide-line">
              {filteredRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={SearchX}
              title="没有匹配的运行"
              description={`没有找到包含“${query.trim()}”的运行，换个关键词试试。`}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setQuery('')}
                >
                  清除搜索
                </Button>
              }
            />
          )}
        </Card>
      </section>
    </div>
  );
}
