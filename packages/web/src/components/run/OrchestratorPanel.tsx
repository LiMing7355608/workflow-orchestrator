import {
  AlertTriangle,
  Loader2,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sendOrchestratorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { trapTabKey } from '../../lib/focus-trap';
import type { BadgeTone } from '../ui/Badge';
import { Badge } from '../ui/Badge';
import type { WorkflowRunDetail } from '../../types/workflow';
import type { AgentInterval, RunRole } from '../../types/operations';
import { Button } from '../ui/Button';
import { CallTranscript } from './CallTranscript';
import { ConversationEntryItem, QueuedHuman } from './ConversationBubbles';
import { RoleDialogue, roleLabels, roleScopes } from './RoleDialogue';

/**
 * 编排器大面板：本次运行贯穿始终的那条对话。
 *
 * 为什么它必须是一个大窗口，而不是右栏里那截窄聊天框：
 *
 * 这个面板的定位是「本次运行的项目负责人」。人在这里说的话构成了整轮编排的
 * 主线——最初的目标、拆解结果、中途改要求、打断拆解重来、改图被拒的原因，
 * 全都在同一条流里。320px 一列能做的只是「发一句、看一句回复」，看不到
 * 「我当初是怎么说的」，也就没有上下文可言；而且那种面板刷新即丢，等于
 * 把这段唯一的凭据存在浏览器的内存里。
 *
 * 视觉语言沿用参考实现的二分，只学信息组织不搬代码：
 * - 人说的话：右对齐、独立底色气泡（那是「我的」）。
 * - 编排器说的话：左对齐、无气泡，只有一个标记（那是「它的」）。
 * - 系统行：muted 小字 + 色调，居中偏左（那是「发生过的事」，不是谁说的）。
 * - 打断：气泡旁一根竖条 + 「打断」标签，因为这句话的作用与普通消息不同——
 *   它没有要求改图，它要求停下手里的活。
 *
 * 面板外壳（portal / 遮罩 / 尺寸 / Esc / 锁滚动 / 焦点归还）与 NodeDetailPanel
 * 是同一套做法，尺寸也一致：两个大面板同时只该有一个，切换时手感必须一样。
 */

export interface OrchestratorPanelProps {
  run: WorkflowRunDetail;
  /** 空值即关闭：与 NodeDetailPanel 用「节点为 null」表示关闭是同一个约定 */
  open: boolean;
  focusCall?: AgentInterval | null;
  initialScope?: RunRole;
  onClose: () => void;
  /**
   * 消息落库后重读运行详情。
   *
   * 会话、图、节点状态全部由后端派生，面板自己不维护第二份对话状态——
   * 两份必然分叉，而分叉之后「哪份才是真的」这个问题没有答案。
   */
  onRunChanged: () => void;
}

export function OrchestratorPanel({
  run,
  open,
  focusCall,
  initialScope,
  onClose,
  onRunChanged,
}: OrchestratorPanelProps) {
  if (!open) {
    return null;
  }
  // createPortal 在渲染期调用：面板由页面深处的按钮触发，父级链上到处是
  // `overflow-hidden`（画布、右栏、页面根容器），留在原地一定会被裁掉。
  return createPortal(
    <PanelSurface key={focusCall?.id ?? initialScope ?? 'control'} run={run} focusCall={focusCall} initialScope={initialScope}
      onClose={onClose} onRunChanged={onRunChanged} />,
    document.body,
  );
}

/** 头部阶段标记：一个运行此刻到底在干什么。 */
interface StageMeta {
  label: string;
  tone: BadgeTone;
}

function stageMeta(run: WorkflowRunDetail): StageMeta {
  if (run.nodeCount === 0) {
    if (run.status === 'failed') {
      return { label: '拆解失败', tone: 'red' };
    }
    if (run.status === 'paused') {
      return { label: '拆解已暂停', tone: 'amber' };
    }
    if (run.planDraft) return { label: '草案待确认', tone: 'amber' };
    if (run.planCheckingAt) return { label: '核对中', tone: 'blue' };
    return { label: '拆解中', tone: 'blue' };
  }
  if (run.status === 'completed') {
    return { label: '已交付', tone: 'green' };
  }
  if (run.status === 'paused') {
    return { label: '已暂停', tone: 'amber' };
  }
  if (run.status === 'waiting_for_boss') {
    return { label: '需要你处理', tone: 'violet' };
  }
  if (run.status === 'failed') {
    return { label: '执行失败', tone: 'red' };
  }
  return { label: '执行中', tone: 'blue' };
}

/**
 * 顶部状态横幅（参考实现的 ChatStatusBanners 思路：当前状态常驻在滚动区之外，
 * 滚上去也不该把它滚丢）。
 *
 * 只画两种会改变「这句话会被怎么理解」的状态：正在拆解时发消息是打断，
 * 上次拆解失败时发消息是重新拆解。其余状态在头部徽标里已经说清了，再挂一条
 * 横幅只会教人忽略这一行。
 */
function stageBanner(run: WorkflowRunDetail): { title: string; detail: string } | null {
  if (run.nodeCount > 0) {
    return null;
  }
  if (run.status === 'failed') {
    return {
      title: '上一次拆解失败了',
      detail: '现在说的话就是新的目标要求：我会把原目标和这句话一起交给 Planner 重拆一遍。',
    };
  }
  if (run.status === 'draft') {
    return {
      title: '正在拆解任务图',
      detail: '现在插话会打断这次拆解，并按你的新要求重来——原目标会保留。',
    };
  }
  return null;
}

function PanelSurface({
  run,
  focusCall,
  initialScope,
  onClose,
  onRunChanged,
}: {
  run: WorkflowRunDetail;
  focusCall?: AgentInterval | null;
  initialScope?: RunRole;
  onClose: () => void;
  onRunChanged: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  // 入场淡入：首帧透明、下一帧补上，靠 CSS transition 完成，不起动画库
  const [entered, setEntered] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [scope, setScope] = useState<RunRole | 'control'>(initialScope ?? 'control');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  /** 乐观回显：句子已经发出、还没落库时先摆出来，别让人以为没点中 */
  const [echo, setEcho] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * 是否跟着底部走。
   *
   * 默认跟：这是一条对话，最新的一句必须在视野里。但人手动往上翻历史时必须
   * 让位——否则每来一条事件就把他拽回底部，读不了任何东西。
   */
  const stick = useRef(!focusCall);

  // onClose 每次渲染都是新函数。挂进 document 的监听通过 ref 取最新的那个，
  // 否则父组件一重渲染就要解绑重建一次键盘监听。
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 面板里可能还有一段没发出去的话，Esc 只负责关面板，不往上冒
        event.stopPropagation();
        closeRef.current();
        return;
      }
      trapTabKey(event, panelRef.current);
    };

    document.addEventListener('keydown', onKeyDown);

    const frame = requestAnimationFrame(() => {
      setEntered(true);
      // 焦点第一下落在输入框：这个面板唯一的动作就是说话，键盘用户不该先
      // 把 Tab 转一圈才找到它
      inputRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      setEntered(false);
      // 触发元素可能已经因为 SSE 刷新被换掉了，能还才还
      if (trigger && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, []);

  // 落库之后真正的条目就到了，乐观回显必须让位：否则同一句话在时间线上
  // 出现两次，读的人会以为它被发了两遍
  useEffect(() => {
    if (echo === null) {
      return;
    }
    if (
      run.conversation.some(
        (entry) => entry.role === 'user' && entry.text === echo,
      )
    ) {
      setEcho(null);
    }
  }, [run.conversation, echo]);

  useEffect(() => {
    if (!stick.current) {
      return;
    }
    const node = scrollerRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [run.conversation.length, pending, echo]);

  const handleScroll = (): void => {
    const node = scrollerRef.current;
    if (!node) {
      return;
    }
    // 距底 48px 之内就算「还在跟着」：一点轻微回滚不该被当成「用户离开了底部」
    stick.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || pending) {
      return;
    }

    setPending(true);
    setError(null);
    setEcho(text);
    setDraft('');

    const result = await sendOrchestratorMessage(run.id, { text });
    setPending(false);

    if (!result) {
      // 网络层失败：后端没收到这句话，把文本还给人，别让他重打一遍
      setEcho(null);
      setDraft(text);
      setError('没有连上后端，这条消息没有发出去。');
      return;
    }

    /**
     * 响应里带着落库之后的会话：一旦确认这句话已经进了事实，就撤掉乐观回显。
     *
     * 不靠「等下一次重读」来判断：重读也可能失败（后端刚好在这两步之间挂掉），
     * 那时回显会永远挂着「发送中」，而它其实早就落库了。
     */
    if (
      result.conversation?.some(
        (entry) => entry.role === 'user' && entry.text === text,
      )
    ) {
      setEcho(null);
    }

    // 成功与「指令被拒」都重读一次：两种结局下这句话与编排器的解释都已经
    // 落成事实，真实原因是会话里的一条记录，不是这里该猜的东西
    onRunChanged();
  };

  const stage = stageMeta(run);
  const banner = stageBanner(run);
  const noGraph = run.nodeCount === 0;
  const placeholder = noGraph
    ? run.status === 'draft'
      ? '打断这次拆解，说要改成什么…（Enter 发送，Shift+Enter 换行）'
      : '说要改成什么，我重新拆一遍…（Enter 发送，Shift+Enter 换行）'
    : '让编排器改这张图…（Enter 发送，Shift+Enter 换行）';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-5">
      {/* 遮罩自己吞掉点击：浮层外的每一寸都是「关掉」，不是「点到背后的东西」 */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn(
          'absolute inset-0 bg-ink/25 transition-opacity duration-150',
          entered ? 'opacity-100' : 'opacity-0',
        )}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(880px, 92vw)',
          height: 'min(92dvh, 780px)',
          // 与节点详情同一层抬升：其余面板靠边框分层，浮层需要一点影子把
          // 「盖在上面」这件事说清楚
          boxShadow: '0 24px 64px -32px rgba(31, 35, 40, 0.45)',
        }}
        className={cn(
          'relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface outline-none transition-[opacity,transform] duration-150 ease-out',
          entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
        )}
      >
        <header className="shrink-0 border-b border-line px-5 pb-3 pt-4">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"
            >
              <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
            </span>
            <span className="text-[11px] text-muted">流程对话</span>
            <Badge tone={stage.tone} dot>
              {stage.label}
            </Badge>
            <button
              type="button"
              aria-label="关闭流程对话"
              title="关闭（Esc）"
              onClick={onClose}
              className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-passive transition-colors hover:bg-subtle hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>

          <h2
            id={titleId}
            className="mt-2 truncate text-[17px] font-medium leading-6 text-ink"
          >
            {run.title}
          </h2>
          <nav aria-label="流程对话层级" className="mt-2 flex flex-wrap items-center gap-1">
            <Button size="sm" variant={scope === 'control' ? 'secondary' : 'ghost'} aria-pressed={scope === 'control'}
              onClick={() => setScope('control')}>总控</Button>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            {roleScopes.map((role) => <Button key={role} size="sm" variant={role === scope ? 'secondary' : 'ghost'}
              aria-pressed={role === scope} onClick={() => setScope(role)}>{roleLabels[role]}</Button>)}
          </nav>
        </header>

        {scope === 'control' ? <>
        {banner ? (
          <div
            role="status"
            className="flex shrink-0 items-start gap-2.5 border-b border-line bg-warning-soft/50 px-5 py-2.5"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning"
              strokeWidth={1.8}
            />
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-ink">{banner.title}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-muted">
                {banner.detail}
              </p>
            </div>
          </div>
        ) : null}

        <div
          ref={scrollerRef}
          onScroll={handleScroll}
          aria-live="polite"
          aria-label="总控会话"
          tabIndex={0}
          className="workspace-scroll min-h-0 flex-1 px-4 py-4 sm:px-5"
        >
          {focusCall && !initialScope && !showAll ? <CallTranscript initial={focusCall} run={run} onShowAll={() => setShowAll(true)} /> :
          <ul className="space-y-4">
            {run.conversation.map((entry) => (
              <li key={entry.id}>
                {/* 视觉语言与节点会话共用一份实现，见 ConversationBubbles */}
                <ConversationEntryItem
                  entry={entry}
                  interruptLabel="打断拆解 · 按这句重来"
                  outputsLabel="拆解过程"
                />
              </li>
            ))}
            {echo ? (
              <li>
                <QueuedHuman text={echo} />
              </li>
            ) : null}
          </ul>}
        </div>

        <footer className="shrink-0 border-t border-line px-5 pb-4 pt-3">
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">给编排器的消息</span>
              <textarea
                ref={inputRef}
                rows={3}
                value={draft}
                disabled={pending}
                placeholder={placeholder}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Enter 发送、Shift+Enter 换行：聊天框的通用约定。用 IME
                  // 组合中的 Enter 不能当发送——中文输入法选词会误触
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
                className="max-h-[160px] min-h-[72px] w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-5 text-ink placeholder:text-passive focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
              />
            </label>
            <button
              type="button"
              onClick={() => void send()}
              disabled={pending || draft.trim().length === 0}
              aria-label="发送给编排器"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-white transition-colors hover:bg-zinc-800 disabled:pointer-events-none disabled:opacity-40"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              ) : (
                <Send className="h-4 w-4" strokeWidth={2} />
              )}
            </button>
          </div>

          <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] leading-4">
            <span className="text-passive">Enter 发送 · Shift+Enter 换行</span>
            {pending ? (
              <span className="flex items-center gap-1.5 text-muted">
                <Loader2
                  aria-hidden="true"
                  className="h-3 w-3 animate-spin text-accent"
                  strokeWidth={2}
                />
                编排器思考中…
              </span>
            ) : error ? (
              <span className="text-danger">{error}</span>
            ) : null}
          </div>
        </footer>
        </> : <RoleDialogue key={scope} run={run} scope={scope} initialCall={scope === initialScope ? focusCall : null} onForward={(text) => {
          const suggestion = '请根据以下' + roleLabels[scope] + '的建议调整任务流程，并核对受影响的依赖。\n\n' + text;
          setDraft((current) => current.trim() ? current + '\n\n' + suggestion : suggestion);
          setShowAll(true);
          setScope('control');
          requestAnimationFrame(() => inputRef.current?.focus());
        }} />}
      </div>
    </div>
  );
}

/*
 * 会话条目的渲染（人话气泡 / 发言人 / 系统行 / 时间戳）已经搬到
 * ConversationBubbles.tsx：节点面板里也要说同一套话，两处各写一份必然分叉。
 */
