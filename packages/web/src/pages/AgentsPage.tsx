import {
  CircleSlash,
  PlugZap,
  Power,
  RefreshCw,
  Search,
  SearchX,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { AgentCard } from '../components/agents/AgentCard';
import { StatCard } from '../components/home/StatCard';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Segmented } from '../components/ui/Segmented';
import { seedAgents } from '../data/agents';
import { fetchAgents, probeAgents } from '../lib/api';
import { cn } from '../lib/cn';
import { useApiResource } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';
import type { AgentAvailability } from '../types/agent';

type AvailabilityFilter = 'all' | AgentAvailability;

const availabilityRank: Record<AgentAvailability, number> = {
  ready: 0,
  installed: 1,
  missing: 2,
};

export function AgentsPage() {
  usePageTitle('Agent 管理');

  const {
    data: remoteAgents,
    source,
    reload,
  } = useApiResource(fetchAgents, seedAgents);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AvailabilityFilter>('all');
  const [probedAt, setProbedAt] = useState('');
  const [probing, setProbing] = useState(false);

  const agents = useMemo(
    () =>
      remoteAgents.map((agent) =>
        agent.id in overrides
          ? { ...agent, enabled: overrides[agent.id] ?? agent.enabled }
          : agent,
      ),
    [remoteAgents, overrides],
  );

  const counts = useMemo(
    () => ({
      all: agents.length,
      ready: agents.filter((agent) => agent.availability === 'ready').length,
      installed: agents.filter((agent) => agent.availability === 'installed')
        .length,
      missing: agents.filter((agent) => agent.availability === 'missing')
        .length,
      enabled: agents.filter((agent) => agent.enabled).length,
    }),
    [agents],
  );

  const filterOptions: Array<{
    value: AvailabilityFilter;
    label: string;
  }> = [
    { value: 'all', label: `全部 ${counts.all}` },
    { value: 'ready', label: `可直接调用 ${counts.ready}` },
    { value: 'installed', label: `仅安装 ${counts.installed}` },
    { value: 'missing', label: `未安装 ${counts.missing}` },
  ];

  const visibleAgents = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    return agents
      .filter((agent) => filter === 'all' || agent.availability === filter)
      .filter((agent) => {
        if (!keyword) {
          return true;
        }
        const haystack = [
          agent.label,
          agent.vendor,
          agent.launch.bin,
          agent.launch.parser,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(keyword);
      })
      .sort((a, b) => {
        const byEnabled = Number(b.enabled) - Number(a.enabled);
        if (byEnabled !== 0) {
          return byEnabled;
        }
        const byAvailability =
          availabilityRank[a.availability] - availabilityRank[b.availability];
        if (byAvailability !== 0) {
          return byAvailability;
        }
        return a.label.localeCompare(b.label);
      });
  }, [agents, filter, query]);

  function handleToggle(id: string, enabled: boolean) {
    setOverrides((previous) => ({ ...previous, [id]: enabled }));
  }

  async function handleProbe() {
    setProbing(true);
    if (source === 'live') {
      // 后端按基线重新探测，再整体刷新目录
      const probed = await probeAgents();
      if (probed) {
        reload();
      }
    }
    setProbedAt(
      new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    setProbing(false);
  }

  function resetFilters() {
    setQuery('');
    setFilter('all');
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
            Agent 管理
          </h1>
          <p className="mt-1.5 max-w-[560px] text-[13px] leading-5 text-muted">
            编排器把每个节点交给一个外部 CLI Agent 执行。这里管理可调度的 Agent
            池、它们的调用参数与能力边界。
          </p>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleProbe()}
            disabled={probing}
            className="max-[700px]:hidden"
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', probing && 'animate-spin')}
              strokeWidth={1.9}
            />
            {probing ? '探测中' : '重新探测'}
          </Button>
          <span className="text-[10px] text-passive max-[700px]:hidden">
            {probedAt
              ? `探测于 ${probedAt}`
              : source === 'live'
                ? '探测结果来自本机'
                : '静态快照'}
          </span>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="可直接调用"
          value={counts.ready}
          hint={`共 ${counts.all} 个预设`}
          icon={PlugZap}
          tone="green"
        />
        <StatCard
          label="已启用"
          value={counts.enabled}
          hint="进入可调度池"
          icon={Power}
          tone="blue"
        />
        <StatCard
          label="未安装"
          value={counts.missing}
          hint="跑到该节点才失败"
          icon={CircleSlash}
          tone="amber"
        />
      </div>

      <Card className="mt-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-[240px] max-[700px]:w-full">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-passive"
              strokeWidth={1.8}
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Agent 或命令"
              aria-label="搜索 Agent"
              className="h-8 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-[12px] text-ink placeholder:text-passive transition-colors focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          </div>

          <div className="max-w-full overflow-x-auto">
            <Segmented
              options={filterOptions}
              value={filter}
              onChange={setFilter}
              ariaLabel="按可用性筛选 Agent"
            />
          </div>

          <span className="ml-auto text-[11px] text-passive max-[700px]:ml-0">
            {visibleAgents.length === agents.length
              ? '全部预设'
              : `筛选出 ${visibleAgents.length} 个`}
          </span>
        </div>
      </Card>

      {visibleAgents.length > 0 ? (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {visibleAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              profile={agent}
              onToggle={handleToggle}
            />
          ))}
        </div>
      ) : (
        <Card className="mt-3">
          <EmptyState
            icon={SearchX}
            title="没有匹配的 Agent"
            description="调整搜索关键词或可用性筛选后再试。"
            action={
              <Button variant="secondary" size="sm" onClick={resetFilters}>
                清除筛选
              </Button>
            }
          />
        </Card>
      )}

      <Card className="mt-4 p-4">
        <h2 className="text-[12px] font-semibold text-ink">
          为什么只接外部 CLI Agent
        </h2>
        <p className="mt-1.5 max-w-[720px] text-[11px] leading-5 text-muted">
          编排器不内置自研 Agent 循环。那套东西要跟着模型能力一起维护，用户也无法替换，
          最后变成编排器里最难改的一块。把平台差异收敛成三件事——可执行文件、参数模板、
          输出解析——新增一个平台就是加一条声明，而不是改调度器。
        </p>
        <div className="mt-3 grid gap-2 text-[11px] leading-5 text-muted sm:grid-cols-3">
          <div className="rounded-lg border border-line bg-subtle/50 px-3 py-2">
            <span className="block font-medium text-ink">提示词走 stdin</span>
            Windows 上的 npm CLI 是 .cmd 包装，参数经 shell 拼接会被重新解释；stdin
            同时解决注入与超长提示词。
          </div>
          <div className="rounded-lg border border-line bg-subtle/50 px-3 py-2">
            <span className="block font-medium text-ink">解析器兼容而非严格</span>
            官方 CLI 的事件结构会变。照旧文档写解析器，升级后会静默解析出空文本，
            所以解析要同时兼容新旧两套。
          </div>
          <div className="rounded-lg border border-line bg-subtle/50 px-3 py-2">
            <span className="block font-medium text-ink">能力在编排期就校验</span>
            声明 streaming / structured / resume / tools，让「该节点要求结构化输出、
            但所选 Agent 不支持」在编排期暴露，而不是跑到一半才崩。
          </div>
        </div>
      </Card>
    </div>
  );
}
