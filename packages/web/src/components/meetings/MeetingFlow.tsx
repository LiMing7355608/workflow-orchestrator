import { ArrowDownRight, FileText, MessageCircle, UsersRound, Waypoints } from 'lucide-react';
import { formatClock } from '../../lib/format';
import type { AgentProfile } from '../../types/agent';
import type { AgentInterval, MeetingView } from '../../types/operations';
import { ActivityTimeline } from '../agents/AgentActivityPanel';
import { AgentLogo } from '../agents/AgentLogo';
import { modelLabel } from '../agents/AgentModelField';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';

export type MeetingSpeaker = 'host' | `role:${string}`;

const stateLabels: Record<AgentInterval['status'], string> = {
  running: '发言中', completed: '已返回', interrupted: '已暂停', failed: '调用失败',
};

export function MeetingFlow({ room, catalogue, intervals, speaker, picked, onSpeaker, onTurn, onDelivery }: {
  room: MeetingView;
  catalogue: AgentProfile[];
  intervals: AgentInterval[];
  speaker: MeetingSpeaker | null;
  picked: string | null;
  onSpeaker: (voice: MeetingSpeaker) => void;
  onTurn: (id: string) => void;
  onDelivery: () => void;
}) {
  const host = catalogue.find((agent) => agent.id === room.host.agentId);
  const hostModel = room.host.model ?? host?.defaultModel;
  const currentHost = intervals.find((turn) => turn.lane === '主持人' && turn.status === 'running');
  const active = intervals.filter((turn) => turn.lane !== '主持人' && turn.status === 'running');
  const selected = intervals.find((turn) => turn.id === picked);
  const summarizing = currentHost?.title === '汇总会议方案';

  return <Card className="min-w-0 space-y-4 p-4 sm:p-5">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><Waypoints className="size-4 text-accent" />会议编排</h2>
      <span className="text-xs text-muted">{room.round ? '第 ' + room.round + ' 轮 · ' : ''}
        {room.status === 'organizing' ? '正在分配角色' : active.length ? active.length + ' 个角色发言中'
          : currentHost ? '主持人处理中' : room.report && !room.reportStale ? '已交付方案' : '等待下一步'}
      </span>
    </header>
    <div className="activity-board">
      <div className="activity-board-grid">
        <section className="relative min-w-0 space-y-2" aria-label="会议角色">
          <h3 className="flex h-5 items-center gap-1.5 text-xs font-semibold text-muted"><UsersRound className="size-3.5" />会议角色</h3>
          {!room.roles.length && <p className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">等待分配角色。</p>}
          {room.roles.map((role) => {
            const agent = catalogue.find((item) => item.id === role.agentId);
            const model = role.model ?? agent?.defaultModel;
            const latest = intervals.find((turn) => turn.lane === role.name && turn.agentId === role.agentId);
            const voice: MeetingSpeaker = `role:${role.name}`;
            return <button key={role.name} type="button" className="activity-member flex w-full min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2 text-left"
              aria-label={'查看' + role.name + '的发言'} aria-pressed={speaker === voice} data-state={latest?.status} onClick={() => onSpeaker(voice)}>
              <AgentLogo src={agent?.logo} label={agent?.label ?? role.name} className="size-7 shrink-0 rounded-md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-ink" title={role.name}>{role.name}</span>
                <span className="block truncate text-[10px] text-muted" title={role.responsibility}>{role.responsibility}</span>
                <span className="block truncate text-[10px] font-medium text-accent" title={model}>{model ? modelLabel(model) : agent?.label ?? role.agentId}</span>
              </span>
              <span className="activity-state shrink-0 text-[10px]" data-state={latest?.status}>{latest ? stateLabels[latest.status] : '待发言'}</span>
            </button>;
          })}
          <span className="activity-connector" aria-hidden="true" data-live={active.length > 0} />
        </section>
        <section className="relative min-w-0 space-y-2" aria-label="主持与收敛">
          <h3 className="flex h-5 items-center gap-1.5 text-xs font-semibold text-accent"><Waypoints className="size-3.5" />主持与收敛</h3>
          <div className="space-y-2 rounded-xl border border-accent/25 bg-accent-soft/25 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <AgentLogo src={host?.logo} label={host?.label ?? '主持人'} className="size-7 shrink-0 rounded-md" />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-ink" title={host?.label ?? room.host.agentId}>{host?.label ?? room.host.agentId}</p>
                {hostModel && <p className="truncate text-[10px] text-accent" title={hostModel}>{modelLabel(hostModel)}</p>}
              </div>
            </div>
            <p className="text-[11px] leading-5 text-muted">{currentHost?.title ?? (room.roundControl === 'host' ? '根据讨论决定继续、提问或汇总' : '按设定轮次组织并汇总')}</p>
            <Button size="sm" variant="secondary" aria-pressed={speaker === 'host'} onClick={() => onSpeaker('host')}>
              <MessageCircle className="size-3.5" />主持人发言
            </Button>
          </div>
          <span className="activity-connector" aria-hidden="true" data-live={summarizing} />
        </section>
        <section className="min-w-0 space-y-2" aria-label="方案交付">
          <h3 className="flex h-5 items-center gap-1.5 text-xs font-semibold text-muted"><FileText className="size-3.5" />方案交付</h3>
          <div className="space-y-2 rounded-xl border border-line bg-subtle/35 px-3 py-2.5">
            <p className="text-xs font-semibold text-ink">{room.report ? 'solution.md' : '会议方案'}</p>
            <p className="text-[11px] text-muted">{room.reportStale ? '有新发言，待重新汇总'
              : room.report ? '已生成并保存到目标目录' : summarizing ? '正在汇总共识与风险' : '等待主持人汇总'}</p>
            <Button size="sm" variant="secondary" onClick={onDelivery}><ArrowDownRight className="size-3.5" />查看交付</Button>
          </div>
        </section>
      </div>
    </div>
    <ActivityTimeline intervals={intervals} picked={picked} onPick={onTurn} />
    {selected && <p className="flex flex-wrap gap-2 rounded-lg border border-line px-3 py-2 text-[11px] text-muted">
      <span className="font-medium text-ink">{selected.title}</span>
      <time dateTime={selected.startedAt}>{formatClock(selected.startedAt)}</time>
      <span>{stateLabels[selected.status]}</span>
      {selected.progress && <span className="break-words">{selected.progress}</span>}
    </p>}
  </Card>;
}
