import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Loader2,
  Send,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { sendOrchestratorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import type {
  AmendmentRejection,
  DagAmendment,
} from '../../types/workflow';

/**
 * 与编排器对话。
 *
 * 编排器在这里的身份是「项目负责人」：用户用自然语言下指令，它把指令落成
 * 对节点图的真实修改。所以这个面板只做三件事——收一句话、把结果铺开、
 * 让外部重新拉取运行详情。
 *
 * 消息只存在组件 state 里，不落库、不进事件流。取舍是刻意的：
 * 对话本身不是编排事实，改动的结果才是。真正需要被重放、被审计的是
 * `dag.amended` 那条事件，而它已经在事实层里了；把聊天记录也写进事件源，
 * 只会让重放多背一堆无法校验的自然语言。代价是刷新页面这段对话会消失——
 * 这也是对的：刷新之后用户要看的是图，而不是刚才聊了什么。
 */

/** 一条对话记录。用户消息与编排器回复的视觉区分见下方的气泡组件。 */
type ChatEntry =
  | { id: string; role: 'human'; text: string }
  | {
      id: string;
      role: 'orchestrator';
      text: string;
      applied: DagAmendment[];
      rejected: AmendmentRejection[];
      /** 后端拒绝了这条指令（或没连上），回复里不会有任何 applied */
      failed: boolean;
    };

/** 空状态下的示例指令：让用户第一次就知道自己能说什么。 */
const SUGGESTIONS = [
  '把审查那个节点换成别的 Agent',
  '这个节点最多重试两次',
  '把消息模块拆成两个节点',
];

/** 改动在界面上的说法。文案只在这里拼，事件流里的同一件事由后端拼。 */
function describeAmendment(amendment: DagAmendment): string {
  if (amendment.kind === 'add-node') {
    const agent = amendment.fields?.find((field) => field.field === 'agentId')?.to;
    return `新增节点 ${amendment.nodeId}${agent ? `（由 ${agent} 执行）` : ''}`;
  }
  if (amendment.kind === 'remove-node') {
    return `移除节点 ${amendment.nodeId}`;
  }
  const fields = (amendment.fields ?? [])
    .map((field) => `${field.field}：${field.from ?? '—'} → ${field.to ?? '—'}`)
    .join('，');
  return `${amendment.nodeId} 的 ${fields}`;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** 用户消息：右对齐、带底色，读起来像「我说的」。 */
function HumanMessage({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[92%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-line bg-subtle px-3 py-2 text-[12px] leading-5 text-ink">
        {text}
      </div>
    </div>
  );
}

/**
 * 编排器回复：左对齐、无底色，与用户消息一眼分得开。
 *
 * 回复的主体是「改了什么」而不是客套话：`applied` 逐条铺开，
 * `rejected` 用警示色写明为什么没改。这两块永远来自后端的实际落地结果。
 */
function AssistantMessage({
  text,
  applied,
  rejected,
  failed,
}: {
  text: string;
  applied: DagAmendment[];
  rejected: AmendmentRejection[];
  failed: boolean;
}) {
  return (
    <div className="flex gap-2">
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md',
          failed ? 'bg-warning-soft text-warning' : 'bg-accent-soft text-accent',
        )}
      >
        <Bot className="h-3 w-3" strokeWidth={1.8} />
      </span>

      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="whitespace-pre-wrap break-words text-[12px] leading-5 text-ink">
          {text}
        </p>

        {applied.length > 0 ? (
          <ul className="space-y-1">
            {applied.map((amendment, index) => (
              <li
                key={`${amendment.kind}-${amendment.nodeId}-${index}`}
                className="flex items-start gap-1.5 rounded-md bg-success-soft px-2 py-1 text-[11px] leading-4 text-success"
              >
                <ArrowRight
                  aria-hidden="true"
                  className="mt-0.5 h-3 w-3 shrink-0"
                  strokeWidth={2}
                />
                <span className="min-w-0 break-words">
                  {describeAmendment(amendment)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {rejected.length > 0 ? (
          <ul className="space-y-1">
            {rejected.map((item) => (
              <li
                key={`${item.nodeId}-${item.reason}`}
                className="flex items-start gap-1.5 rounded-md bg-warning-soft px-2 py-1 text-[11px] leading-4 text-warning"
              >
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 h-3 w-3 shrink-0"
                  strokeWidth={2}
                />
                <span className="min-w-0 break-words">
                  <span className="font-medium">{item.nodeId}</span>：{item.reason}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export interface OrchestratorChatProps {
  runId: string;
  /** 改动生效后让外部重新拉取运行详情（图、节点、事件都会变） */
  onRunChanged?: () => void;
  className?: string;
}

export function OrchestratorChat({
  runId,
  onRunChanged,
  className,
}: OrchestratorChatProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // 新消息落地就滚到底：这是一个对话，最新的一句话必须在视野里
  useEffect(() => {
    const node = scroller.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries, pending]);

  // 换运行就清空：上一轮运行的对话留着只会让人以为是这一轮的
  useEffect(() => {
    setEntries([]);
    setDraft('');
    setPending(false);
  }, [runId]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || pending) {
      return;
    }

    setEntries((prev) => [
      ...prev,
      { id: nextId('human'), role: 'human', text },
    ]);
    setDraft('');
    setPending(true);

    const result = await sendOrchestratorMessage(runId, { text });
    setPending(false);

    if (!result) {
      setEntries((prev) => [
        ...prev,
        {
          id: nextId('orchestrator'),
          role: 'orchestrator',
          text: '没有连上后端，这条指令没有发出去。',
          applied: [],
          rejected: [],
          failed: true,
        },
      ]);
      return;
    }

    setEntries((prev) => [
      ...prev,
      {
        id: nextId('orchestrator'),
        role: 'orchestrator',
        text: result.reply,
        applied: result.applied,
        rejected: result.rejected,
        failed: Boolean(result.failure),
      },
    ]);

    // 只有真的改动了才需要重读：没有改动时图没变，重读只是白跑一趟
    if (result.applied.length > 0) {
      onRunChanged?.();
    }
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div
        ref={scroller}
        aria-live="polite"
        aria-label="编排器对话"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
      >
        {entries.length === 0 && !pending ? (
          <div className="space-y-2">
            <p className="text-[11px] leading-5 text-muted">
              直接说要改什么。编排器会把指令落成对节点图的真实修改，
              已经开始执行的节点不会被改，它会说明原因。
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    setDraft(suggestion);
                    input.current?.focus();
                  }}
                  className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] text-muted transition-colors hover:border-line-strong hover:text-ink"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {entries.map((entry) =>
          entry.role === 'human' ? (
            <HumanMessage key={entry.id} text={entry.text} />
          ) : (
            <AssistantMessage
              key={entry.id}
              text={entry.text}
              applied={entry.applied}
              rejected={entry.rejected}
              failed={entry.failed}
            />
          ),
        )}

        {pending ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2
              aria-hidden="true"
              className="h-3 w-3 animate-spin text-accent"
              strokeWidth={2}
            />
            编排器思考中…
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={input}
            rows={2}
            value={draft}
            disabled={pending}
            aria-label="给编排器的指令"
            placeholder="让编排器改这张图…（Enter 发送，Shift+Enter 换行）"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter 发送、Shift+Enter 换行：这是聊天框的通用约定，
              // 用 IME 组合中的 Enter 不能当发送（中文输入法选词会误触）
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            className="min-h-[52px] w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] leading-5 text-ink placeholder:text-passive focus:border-line-strong focus:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={pending || draft.trim().length === 0}
            aria-label="发送指令"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-white transition-colors hover:bg-zinc-800 disabled:pointer-events-none disabled:opacity-40"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Send className="h-3.5 w-3.5" strokeWidth={2} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
