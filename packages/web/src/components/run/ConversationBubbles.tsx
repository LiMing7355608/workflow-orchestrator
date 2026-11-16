import {
  AlertTriangle,
  Bot,
  Brain,
  CornerDownRight,
  Info,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import type { ConversationEntry } from '../../types/workflow';

/**
 * 会话气泡的唯一实现：编排器面板与节点面板共用这一份。
 *
 * 为什么要抽出来而不是各写一套：这两处说的是同一种东西（有人说话、有人记账），
 * 视觉语言必须一模一样——人右对齐带气泡、执行者左对齐无气泡、系统行 muted
 * 小字带色调、打断消息带竖条与标签。各写一套的必然结局是「编排器面板里的
 * 打断标记是橙色竖条，节点面板里是灰色小字」，而读者会以为那代表两类不同的事。
 *
 * 参数化只留两处差异，因为它们在两个面板里确实叫法不同：
 * - `interruptLabel`：编排器面板说「打断拆解」，节点面板说「打断执行」。
 * - `outputsLabel`：编排器面板叫「拆解过程」，节点面板叫「本轮输出」。
 */

export interface ConversationEntryItemProps {
  entry: ConversationEntry;
  /** 打断标签的措辞，见文件头 */
  interruptLabel: string;
  /** 系统行里那段执行输出的名字，见文件头 */
  outputsLabel: string;
}

/** 一条会话：按角色分三种画法。 */
export function ConversationEntryItem({
  entry,
  interruptLabel,
  outputsLabel,
}: ConversationEntryItemProps) {
  if (entry.role === 'user') {
    return <HumanEntry entry={entry} interruptLabel={interruptLabel} />;
  }
  if (entry.role === 'orchestrator' || entry.role === 'agent') {
    // 编排器与节点执行者共用同一画法：它们都是「系统这边说的」，区别只在于
    // 谁说的——那件事由它所在的面板回答，不需要再分一套视觉。
    return <SpeakerEntry entry={entry} />;
  }
  return <SystemEntry entry={entry} outputsLabel={outputsLabel} />;
}

/** 人说的话：右对齐、独立底色气泡。 */
function HumanEntry({
  entry,
  interruptLabel,
}: {
  entry: ConversationEntry;
  interruptLabel: string;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      {entry.interrupt ? (
        <span className="flex items-center gap-1 text-[10px] font-medium text-warning">
          <CornerDownRight
            aria-hidden="true"
            className="h-3 w-3"
            strokeWidth={2}
          />
          {interruptLabel}
        </span>
      ) : null}
      {/* 上限 560px：面板有 880px，但一句话摊到满宽之后眼睛要横着扫，
          气泡的宽度应该跟着「一句话有多长」走，不是跟着面板走 */}
      <div className="flex max-w-[min(86%,560px)] items-stretch gap-1.5">
        {/* 竖条是「这句与普通消息不同」的标记：它打断了正在进行的活 */}
        {entry.interrupt ? (
          <span
            aria-hidden="true"
            className="w-[2px] shrink-0 rounded-full bg-warning"
          />
        ) : null}
        <p className="min-w-0 whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-line bg-subtle px-3 py-2 text-[13px] leading-5 text-ink">
          {entry.text}
        </p>
      </div>
      <MessageTimestamp at={entry.at} />
    </div>
  );
}

/** 系统这边的发言（编排器 / 节点执行者）：左对齐、无气泡，只有一个小标记。 */
function SpeakerEntry({ entry }: { entry: ConversationEntry }) {
  return (
    <div className="flex gap-2.5">
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"
      >
        <Bot className="h-3 w-3" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-ink">
          {entry.text}
        </p>
        <MessageTimestamp at={entry.at} />
      </div>
    </div>
  );
}

/**
 * 系统行：阶段变化、改图结果、失败、打断、重置。
 *
 * 它不居中而是左对齐、与发言同一条轴：这些行是行为的注脚，居中会让人以为
 * 它们是「另一列信息」，读的时候要跳着看。
 */
function SystemEntry({
  entry,
  outputsLabel,
}: {
  entry: ConversationEntry;
  outputsLabel: string;
}) {
  const tone = entry.tone ?? 'info';
  const [expanded, setExpanded] = useState(false);
  const outputs = entry.outputs ?? [];
  const hasOutputs = outputs.length > 0;

  return (
    <div className="flex items-start gap-2 pl-1">
      <span aria-hidden="true" className="mt-[3px] shrink-0">
        {tone === 'warning' ? (
          <AlertTriangle className="h-3 w-3 text-warning" strokeWidth={1.8} />
        ) : tone === 'success' ? (
          <Sparkles className="h-3 w-3 text-success" strokeWidth={1.8} />
        ) : (
          <Info className="h-3 w-3 text-passive" strokeWidth={1.8} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'min-w-0 whitespace-pre-wrap break-words text-[11px] leading-5',
            tone === 'warning'
              ? 'text-warning'
              : tone === 'success'
                ? 'text-success'
                : 'text-muted',
          )}
        >
          {entry.text}
        </p>
        {/*
          过程输出默认收起：它可能有几十步，展开就把整段对话冲散了。
          但必须能展开——「它是怎么想出来的」是判断该不该接受它的依据。
        */}
        {hasOutputs ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-0.5 text-[11px] text-accent hover:underline focus-visible:underline"
          >
            {expanded ? `收起${outputsLabel}` : `展开${outputsLabel}（${outputs.length} 步）`}
          </button>
        ) : null}
        {expanded ? <PlanOutputs outputs={outputs} /> : null}
      </div>
      <MessageTimestamp at={entry.at} />
    </div>
  );
}

/**
 * 一轮执行里的输出。
 *
 * 按类型分级，与节点时间线同一套语言：思考弱化成带竖线的斜体行、工具调用
 * 单行、用量的 passive 小字。这里不追求完整回放，只让人能快速看出「它读了
 * 什么、想了什么、最后交了什么」。
 */
function PlanOutputs({
  outputs,
}: {
  outputs: NonNullable<ConversationEntry['outputs']>;
}) {
  return (
    <ul className="mt-1.5 space-y-1 border-l-2 border-line-strong pl-2.5">
      {outputs.map((output) => {
        if (output.kind === 'thinking') {
          return (
            <li key={output.id} className="flex gap-1.5">
              <Brain
                aria-hidden="true"
                className="mt-[3px] h-3 w-3 shrink-0 text-passive"
                strokeWidth={1.8}
              />
              <span className="min-w-0 whitespace-pre-wrap break-words text-[11px] leading-4 text-passive">
                {output.text}
              </span>
            </li>
          );
        }
        if (output.kind === 'tool') {
          return (
            <li key={output.id} className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <Wrench
                aria-hidden="true"
                className="h-3 w-3 shrink-0 text-review"
                strokeWidth={1.8}
              />
              <span className="shrink-0 font-mono text-ink">
                {output.toolName ?? '工具'}
              </span>
              {output.text && output.text !== output.toolName ? (
                <span className="min-w-0 truncate text-muted">{output.text}</span>
              ) : null}
            </li>
          );
        }
        if (output.kind === 'usage') {
          return (
            <li key={output.id} className="text-[10px] text-passive">
              {output.text}
            </li>
          );
        }
        if (output.kind === 'error') {
          return (
            <li
              key={output.id}
              className="whitespace-pre-wrap break-words text-[11px] leading-4 text-danger"
            >
              {output.text}
            </li>
          );
        }
        return (
          <li
            key={output.id}
            className="whitespace-pre-wrap break-words text-[11px] leading-4 text-muted"
          >
            {output.text}
          </li>
        );
      })}
    </ul>
  );
}

/** 乐观回显：这句话已经发出去了，但还没落库。虚线框说「它还不是事实」。 */
export function QueuedHuman({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <p className="max-w-[min(86%,560px)] whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-dashed border-line-strong px-3 py-2 text-[13px] leading-5 text-muted">
        {text}
      </p>
      <span className="text-[10px] text-passive">发送中…</span>
    </div>
  );
}

/**
 * 每条消息的时间戳。
 *
 * 精确到秒：一次改图与它的回复常常落在同一分钟里，只到分钟就看不出先后，
 * 而「谁先谁后」正是这段对话唯一的结构。
 */
function MessageTimestamp({ at }: { at: string }) {
  return (
    <time
      dateTime={at}
      className="shrink-0 tabular-nums text-[10px] text-passive"
    >
      {formatClock(at)}
    </time>
  );
}
