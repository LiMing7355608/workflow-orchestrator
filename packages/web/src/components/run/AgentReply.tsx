import { useMemo } from 'react';
import { CollapsibleText } from '../ui/CollapsibleText';

function inspectReply(text: string) {
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!source.startsWith('{')) return null;
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    const title = typeof value.title === 'string' ? value.title : undefined;
    const summary = typeof value.summary === 'string' ? value.summary : undefined;
    const nodes = Array.isArray(value.nodes) ? value.nodes.length : undefined;
    const findings = Array.isArray(value.findings) ? value.findings.length : undefined;
    return { title: title || (nodes !== undefined ? '任务图' : findings !== undefined ? '核对结果' : '结构化回复'),
      summary, detail: nodes !== undefined ? nodes + ' 个任务节点' : findings !== undefined ? findings + ' 项核对意见' : undefined };
  } catch {
    return { title: '结构化回复', summary: undefined, detail: undefined, partial: true };
  }
}

export function AgentReply({ text, active = false }: { text: string; active?: boolean }) {
  const structure = useMemo(() => inspectReply(text), [text]);
  if (!text.trim()) return null;
  if (!structure) return <CollapsibleText text={text} lines={4}
    className="whitespace-pre-wrap text-xs leading-6 text-ink" />;

  return <div className="min-w-0 space-y-1.5">
    <p className="break-words text-xs font-semibold text-ink">
      {active && structure.partial ? '正在生成结构化回复…' : structure.title}
      {structure.detail && <span className="ml-2 font-normal text-muted">{structure.detail}</span>}
    </p>
    {structure.summary && <CollapsibleText text={structure.summary} lines={3}
      className="whitespace-pre-wrap text-xs leading-5 text-muted" />}
    <details className="text-[11px] text-accent">
      <summary className="cursor-pointer py-1">原始回复</summary>
      <pre className="workspace-scroll mt-1 max-h-64 whitespace-pre-wrap rounded-lg bg-subtle p-2.5 text-[11px] leading-5 text-ink [overflow-wrap:anywhere]"
        tabIndex={0}>{text}</pre>
    </details>
  </div>;
}
