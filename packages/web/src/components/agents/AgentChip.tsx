import { findAgent, findAgentByLabel } from '../../data/agents';
import { cn } from '../../lib/cn';
import { AgentLogo } from './AgentLogo';

interface AgentChipProps {
  /** 节点绑定的 Agent id；人类审批与编排器节点为空 */
  agentId?: string;
  /** agentId 缺失时的执行者名称 */
  label: string;
  /** 只显示图标，名称由调用方自己排版 */
  iconOnly?: boolean;
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}

/**
 * 节点上的执行者标识：厂商图标 + 平台名。
 *
 * 目录暂时读静态 seedAgents；后端接上后改为从 Agent 目录 store 取，
 * 保证「节点显示什么 Agent」与「Agent 管理页的启用状态」是同一份数据。
 */
export function AgentChip({
  agentId,
  label,
  iconOnly = false,
  className,
  iconClassName,
  textClassName,
}: AgentChipProps) {
  const agent = findAgent(agentId) ?? findAgentByLabel(label);
  const text = agent?.label ?? label;

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      {agent ? (
        <AgentLogo
          src={agent.logo}
          label={agent.label}
          className={cn('h-3.5 w-3.5', iconClassName)}
        />
      ) : iconOnly ? (
        <span
          aria-hidden="true"
          className={cn(
            'h-3.5 w-3.5 shrink-0 rounded-sm bg-subtle',
            iconClassName,
          )}
        />
      ) : null}
      {iconOnly ? null : (
        <span className={cn('truncate', textClassName)}>{text}</span>
      )}
    </span>
  );
}
