import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { formatCommand } from '../../data/agents';
import {
  availabilityMeta,
  capabilityMeta,
  capabilityOrder,
  parserLabels,
  permissionMeta,
  permissionOrder,
  sessionDeriveMeta,
} from '../../lib/agent-meta';
import { cn } from '../../lib/cn';
import type { AgentProfile } from '../../types/agent';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Toggle } from '../ui/Toggle';
import { AgentLogo } from './AgentLogo';

interface AgentCardProps {
  profile: AgentProfile;
  onToggle: (id: string, enabled: boolean) => void;
}

function formatTimeout(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `超时 ${minutes} 分钟` : `超时 ${Math.round(ms / 1000)} 秒`;
}

export function AgentCard({ profile, onToggle }: AgentCardProps) {
  const [copied, setCopied] = useState(false);
  const availability = availabilityMeta[profile.availability];
  const session = sessionDeriveMeta[profile.session.derive];
  const command = formatCommand(profile);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card
      className={cn(
        'flex flex-col transition-opacity duration-150',
        profile.enabled ? undefined : 'opacity-70',
      )}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-subtle">
          <AgentLogo
            src={profile.logo}
            label={profile.label}
            className="h-5 w-5"
          />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="truncate text-[13px] font-semibold text-ink">
              {profile.label}
            </h3>
            <Badge tone={availability.tone} dot>
              {availability.label}
            </Badge>
          </div>
          <p className="mt-1 truncate text-[11px] text-passive">
            {profile.vendor}
            <span aria-hidden="true"> · </span>
            {parserLabels[profile.launch.parser]}
            {profile.version ? ` · v${profile.version}` : ''}
          </p>
        </div>

        <Toggle
          checked={profile.enabled}
          onChange={(next) => onToggle(profile.id, next)}
          label={`${profile.enabled ? '停用' : '启用'} ${profile.label}`}
        />
      </div>

      <div className="px-4">
        <div className="relative rounded-lg border border-line bg-subtle/60 py-2 pl-2.5 pr-10">
          <code className="block overflow-x-auto whitespace-pre font-mono text-[11px] leading-5 text-muted">
            {command}
          </code>
          <button
            type="button"
            onClick={copyCommand}
            aria-label="复制命令"
            title="复制命令"
            className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md border border-transparent text-passive transition-colors hover:border-line hover:bg-surface hover:text-ink"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" strokeWidth={2} />
            ) : (
              <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
            )}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 pt-3">
        {capabilityOrder.map((key) => {
          const supported = profile.capabilities[key];
          const meta = capabilityMeta[key];

          return (
            <Badge
              key={key}
              tone={supported ? 'blue' : 'neutral'}
              className={supported ? undefined : 'opacity-55'}
              title={meta.description}
            >
              {meta.label}
            </Badge>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 px-4 pt-2.5">
        <span className="shrink-0 text-[10px] text-passive">权限</span>
        <div className="flex flex-wrap items-center gap-1">
          {permissionOrder.map((policy) => {
            const args = profile.permissionArgs[policy];
            const meta = permissionMeta[policy];
            const mapped = args.length > 0;

            return (
              <Badge
                key={policy}
                tone={mapped ? meta.tone : 'neutral'}
                title={
                  mapped
                    ? `${policy} → ${args.join(' ')}`
                    : `${meta.description}（该平台没有对应开关）`
                }
                className={cn(
                  'px-1.5 py-0 text-[10px] leading-4',
                  mapped ? undefined : 'opacity-55',
                )}
              >
                {meta.short}
              </Badge>
            );
          })}
        </div>
        {profile.windowsShim === 'bypass' ? (
          <span
            className="ml-auto shrink-0 text-[10px] text-passive"
            title="Windows 上 npm 装成 .cmd shim，命令行超长时会绕过 shim 直启 Node 入口"
          >
            .cmd 直启
          </span>
        ) : null}
      </div>

      {profile.configFiles?.length ? (
        <p className="px-4 pt-2 text-[10px] text-passive">
          侧信道配置
          <span aria-hidden="true"> · </span>
          <code className="font-mono">
            {profile.configFiles.map((file) => file.envVar).join(' / ')}
          </code>
        </p>
      ) : null}

      {profile.note ? (
        <p className="px-4 pt-2.5 text-[11px] leading-5 text-muted">
          {profile.note}
        </p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
        <span
          className="truncate text-[10px] text-passive"
          title={profile.source ?? availability.description}
        >
          {profile.source ?? availability.description}
        </span>
        <span className="shrink-0 text-[10px] text-passive" title={session.description}>
          {session.label}
          <span aria-hidden="true"> · </span>
          {formatTimeout(profile.timeoutMs)}
        </span>
      </div>
    </Card>
  );
}
