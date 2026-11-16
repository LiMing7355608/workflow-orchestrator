import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Hand,
  Plus,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { PipelineStrip } from '../components/home/PipelineStrip';
import { RecentRunItem } from '../components/home/RecentRunItem';
import { RunOverview } from '../components/home/RunOverview';
import { StatCard } from '../components/home/StatCard';
import { buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { seedRuns } from '../data/seed';
import { fetchRuns } from '../lib/api';
import { useApiResource, useLiveRefresh } from '../lib/use-api';
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

  const { data: runs, source, reload } = useApiResource(fetchRuns, seedRuns);
  useLiveRefresh(source === 'live', reload);

  const runningCount = runs.filter((run) => run.status === 'running').length;
  const waitingCount = runs.filter(
    (run) => run.status === 'waiting_for_boss',
  ).length;
  const completedCount = runs.filter(
    (run) => run.status === 'completed',
  ).length;

  const recentRuns = [...runs]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, 3);

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

      <section className="mt-8 grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start gap-3 max-[950px]:grid-cols-1">
        <div>
          <div className="flex items-end justify-between gap-4">
            <SectionHeading
              title="最近运行"
              description="最近更新的 3 个运行。"
            />
            <Link
              to="/runs"
              className="inline-flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-ink"
            >
              查看全部
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.8} />
            </Link>
          </div>

          <Card className="mt-3 divide-y divide-line overflow-hidden">
            {recentRuns.map((run) => (
              <RecentRunItem key={run.id} run={run} />
            ))}
          </Card>
        </div>

        <div>
          <SectionHeading
            title="运行概览"
            description="按状态统计当前运行。"
          />
          <RunOverview runs={runs} className="mt-3" />
        </div>
      </section>
    </div>
  );
}
