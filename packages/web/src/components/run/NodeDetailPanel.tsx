import {
  GitBranch,
  Loader2,
  MessageSquare,
  Play,
  RotateCcw,
  ScrollText,
  Send,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  decideApproval,
  resetNode,
  runNode,
  sendNodeMessage,
  stopNode,
} from '../../lib/api';
import { cn } from '../../lib/cn';
import { trapTabKey } from '../../lib/focus-trap';
import { formatDuration } from '../../lib/format';
import { useIdentity } from '../../lib/identity-store';
import { displayNodeStatus, nodeStatusMeta, nodeTypeMeta } from '../../lib/workflow-meta';
import type {
  ConversationEntry,
  NodeStatus,
  WorkflowNode,
  WorkflowRunDetail,
} from '../../types/workflow';
import { AgentChip } from '../agents/AgentChip';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CollapsibleText } from '../ui/CollapsibleText';
import { Segmented } from '../ui/Segmented';
import { ConversationEntryItem, QueuedHuman } from './ConversationBubbles';
import { NodeTimeline } from './NodeTimeline';

/**
 * 节点详情大面板。
 *
 * 为什么不再放右栏：一个节点的事件动辄四五十条、正文还是整段 markdown，
 * 320px 宽的一列只能把它们压成一条条两行高的碎片——读的人要不停上下滚，
 * 还看不清 diff。详情是「一个节点的全部经过」，它需要自己的画布，不再和
 * 拓扑图抢宽度；右栏则退回它真正擅长的事：运行级概览。
 *
 * 三个刻意的实现决定：
 * - 用 createPortal 挂到 body。面板由页面深处的按钮触发，父级链上到处是
 *   `overflow-hidden`（画布、右栏、页面根容器），留在原地一定会被裁掉。
 * - 尺寸固定成 min(880px, 92vw) × min(80vh, 720px)：够宽到 diff 不用横向
 *   滚，又不至于铺满屏幕失去「这是浮层、下面是运行现场」的层次。
 * - 挂载即锁定 body 滚动、把焦点收进面板、卸载时还给触发元素。浮层打开还
 *   能滚动背后页面，是最容易被误操作的一种破绽。
 */

export interface NodeDetailPanelProps {
  run: WorkflowRunDetail;
  /** 空值即关闭：不额外维护 open 布尔值，避免「有节点但没打开」的中间态 */
  node: WorkflowNode | null;
  onClose: () => void;
  /** 点上游依赖时原地换成那个节点，不叠第二层浮层 */
  onSelectNode: (nodeId: string) => void;
  /**
   * 这个运行的事实变了（审批落盘、节点被单跑/停止/重置）。
   *
   * 显式的刷新回调而不是让面板自己再取一份：状态全部由后端派生，
   * 前端自己猜结果迟早会与事实分叉。
   */
  onRunChanged?: () => void;
}

export function NodeDetailPanel({
  run,
  node,
  onClose,
  onSelectNode,
  onRunChanged,
}: NodeDetailPanelProps) {
  if (!node) {
    return null;
  }
  // createPortal 在渲染期调用，副作用（锁滚动、抢焦点）全部落在面板自身，
  // 这样它们天然与「打开」同生命周期，不必手写 open 判断。
  return createPortal(
    <PanelSurface
      run={run}
      node={node}
      onClose={onClose}
      onSelectNode={onSelectNode}
      onRunChanged={onRunChanged}
    />,
    document.body,
  );
}

function PanelSurface({
  run,
  node,
  onClose,
  onSelectNode,
  onRunChanged,
}: {
  run: WorkflowRunDetail;
  node: WorkflowNode;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onRunChanged?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 入场淡入用：首帧透明、下一帧补上，靠 CSS transition 完成，不起动画库
  const [entered, setEntered] = useState(false);

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
        // 面板里可能还有正在输入的审批理由，Esc 只负责关面板，不往上冒
        event.stopPropagation();
        closeRef.current();
        return;
      }
      // Tab 环与编排器大面板共用一份实现（见 lib/focus-trap）
      trapTabKey(event, panelRef.current);
    };

    document.addEventListener('keydown', onKeyDown);

    const frame = requestAnimationFrame(() => {
      setEntered(true);
      // 焦点落在面板容器而不是第一个输入框：读屏会先念标题，
      // 键盘用户也不会一进来就被塞进「审批人」里
      panelRef.current?.focus();
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

  const typeMeta = nodeTypeMeta[node.type];
  const statusMeta = nodeStatusMeta[displayNodeStatus(node)];
  const TypeIcon = typeMeta.icon;

  const dependencies = node.dependsOn.map((id) => ({
    id,
    title: run.nodes.find((item) => item.id === id)?.title ?? id,
  }));

  // 执行输出走内存过滤而不是 /nodes/:nodeId/events：同一批视图已经在
  // run.events 里了，SSE 刷新运行详情时这里自动跟着变，还省掉每个节点
  // 一次往返。那个接口留给外部调用和将来的分页。
  const nodeEvents = useMemo(
    () => run.events.filter((event) => event.nodeId === node.id),
    [run.events, node.id],
  );

  /**
   * 节点会话。
   *
   * 与会话面板同样以「后端派生出来的那一份」为唯一来源，面板自己不攒对话：
   * 两份状态迟早分叉，分叉之后没有任何一处能判定哪份是真的。useMemo 只是
   * 为了稳住引用——`?? []` 每次渲染都会造一个新数组，把它塞进 effect 依赖里
   * 等于让那个 effect 每次都跑。
   */
  const nodeConversation = useMemo(
    () => run.nodeConversations[node.id] ?? [],
    [run.nodeConversations, node.id],
  );

  /**
   * 主体视图：会话 / 原始时间线，互斥（取舍见下面 section 的注释）。
   *
   * 默认会话：这个面板被点开时，人问的第一句通常是「它干到哪儿了、我说过什么」。
   */
  const [view, setView] = useState<NodePanelView>('conversation');
  /** 乐观回显：这句话已经发出去了，但还没落库 */
  const [echo, setEcho] = useState<string | null>(null);

  // 换节点时把视图与回显复位：上一条没落库的话不该挂在新节点下面
  useEffect(() => {
    setView('conversation');
    setEcho(null);
  }, [node.id]);

  // 落库之后真正的条目就到了，乐观回显必须让位：否则同一句话在会话里
  // 出现两次，读的人会以为它被发了两遍
  useEffect(() => {
    if (echo === null) {
      return;
    }
    if (
      nodeConversation.some(
        (entry) => entry.role === 'user' && entry.text === echo,
      )
    ) {
      setEcho(null);
    }
  }, [nodeConversation, echo]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
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
          height: 'min(80vh, 720px)',
          // 只有这一层抬升：其余面板一律靠边框分层，浮层需要一点影子把
          // 「盖在上面」这件事说清楚
          boxShadow: '0 24px 64px -32px rgba(31, 35, 40, 0.45)',
        }}
        className={cn(
          'relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface outline-none transition-[opacity,transform] duration-150 ease-out',
          entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
        )}
      >
        <header className="shrink-0 border-b border-line px-5 pb-3.5 pt-4">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'grid h-7 w-7 shrink-0 place-items-center rounded-md',
                typeMeta.tile,
              )}
            >
              <TypeIcon className="h-3.5 w-3.5" strokeWidth={1.8} />
            </span>
            <span className="text-[11px] text-muted">{typeMeta.label}节点</span>
            <Badge tone={statusMeta.tone} dot>
              {statusMeta.label}
            </Badge>
            {/*
              失败原因顶到标题下方：用户点开一个红节点，第一个问题就是
              「为什么」。只在时间线里留着等于让他自己往下翻。
            */}
            {node.failureReason ? (
              <span
                title={node.failureReason}
                className="min-w-0 truncate text-[11px] text-danger"
              >
                {node.failureReason}
              </span>
            ) : null}
            <button
              type="button"
              aria-label="关闭节点详情"
              title="关闭（Esc）"
              onClick={onClose}
              className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-passive transition-colors hover:bg-subtle hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </div>

          <h2
            id={titleId}
            className="mt-2 text-[17px] font-medium leading-6 text-ink"
          >
            {node.title}
          </h2>
          {/*
            节点描述常常是一整段任务书（产出物、验收标准都在里面），
            折两行等于把关键要求藏起来。大面板里给三行预览 + 展开全文。
          */}
          <CollapsibleText
            text={node.description}
            lines={3}
            threshold={60}
            className="mt-0.5 text-[12px] leading-5 text-muted"
          />

          {/* 元信息压成一行：这是速览，主体是下面那条时间线 */}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
            <AgentChip
              agentId={node.agentId}
              label={node.agent}
              textClassName="text-ink"
              iconClassName="h-3.5 w-3.5"
            />
            <MetaItem label="耗时" value={formatDuration(node.durationMs)} />
            <MetaItem label="尝试" value={`${node.attempts} 次`} />
            <MetaItem label="上游依赖" value={`${node.dependsOn.length} 个`} />
            <MetaItem label="文件" value={`${node.files.length} 个`} />
          </div>

          {dependencies.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {dependencies.map((dependency) => (
                <button
                  key={dependency.id}
                  type="button"
                  // 原地替换内容而不是叠一层浮层：依赖链常常要看两三跳，
                  // 一层层叠加会把人困在退不出来的栈里
                  onClick={() => onSelectNode(dependency.id)}
                  className="inline-flex max-w-[240px] items-center gap-1 rounded border border-line bg-subtle/40 px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-line-strong hover:text-ink"
                >
                  <GitBranch
                    className="h-2.5 w-2.5 shrink-0 text-passive"
                    strokeWidth={1.8}
                  />
                  <span className="truncate">{dependency.title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </header>

        {/*
          主体：两个视图互斥，默认是会话。

          为什么不是「时间线常驻 + 会话挂在下面」：这两块讲的是同一批事实。
          时间线把每条 agent 输出、每次 start/end 都铺成一行；会话把它折成
          「轮次 + 插话 + 每轮输出（默认收起）」。并排或上下堆叠，同一个节点
          的同一段输出就会在同一个面板里出现两遍，而面板高度只有 720px ——
          分给两块之后，两块都读不完整。

          所以取舍是：默认给人看的会话，时间线降级成「排查视图」，切换才进。
          时间线仍然是唯一的原始流水（精确时间列、工具调用、产物 diff 预览），
          会话则承担「我中途改过什么要求、它因此重跑了几轮」这条叙事。
        */}
        <section className="flex min-h-0 flex-1 flex-col px-5 pb-3 pt-3">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <Segmented
              ariaLabel="节点详情视图"
              value={view}
              onChange={setView}
              options={[
                {
                  value: 'conversation',
                  label:
                    nodeConversation.length > 0
                      ? `节点会话（${nodeConversation.length}）`
                      : '节点会话',
                },
                { value: 'timeline', label: `原始时间线（${nodeEvents.length}）` },
              ]}
            />
            <span className="flex items-center gap-1 text-[10px] text-passive">
              <ScrollText className="h-3 w-3" strokeWidth={1.8} />
              {view === 'timeline' ? '排查视图' : '对话与轮次'}
            </span>
          </div>

          {view === 'timeline' ? (
            /* key 绑 node.id：切节点时把「哪些长条目被展开」重置掉，
               否则上一条输出的展开状态会串到下一个节点 */
            <NodeTimeline
              key={`timeline-${node.id}`}
              runId={run.id}
              node={node}
              events={nodeEvents}
              variant="roomy"
            />
          ) : (
            <>
              <NodeConversation entries={nodeConversation} echo={echo} />
              <NodeComposer
                runId={run.id}
                nodeId={node.id}
                state={
                  node.status === 'running'
                    ? 'running'
                    : node.status === 'waiting_approval'
                      ? 'waiting_approval'
                      : 'idle'
                }
                onEcho={setEcho}
                onDone={onRunChanged}
              />
            </>
          )}
        </section>

        {node.status === 'waiting_approval' ? (
          <footer className="shrink-0 border-t border-line">
            <ApprovalActions
              runId={run.id}
              node={node}
              onDone={onRunChanged}
            />
          </footer>
        ) : null}

        {/* 节点级动作常驻在审批区之下：审批是此刻唯一阻塞运行的那件事，
            视觉上先给它；这一行是通用控制，安静一点正好。 */}
        <footer className="shrink-0 border-t border-line px-5 py-2">
          <NodeActions
            runId={run.id}
            nodeId={node.id}
            status={displayNodeStatus(node)}
            onDone={onRunChanged}
          />
        </footer>
      </div>
    </div>
  );
}

/**
 * 主体视图。
 *
 * `timeline` 不叫「执行时间线」而叫「原始时间线」：它是排查用的那一份
 * （精确时间列、工具调用、产物 diff），会话才是给人读的那一份。
 */
type NodePanelView = 'conversation' | 'timeline';

/**
 * 节点会话流。
 *
 * 与编排器会话共用同一套气泡（见 ConversationBubbles），差异只有两处措辞：
 * 这里的打断叫「打断执行」，系统行里展开的东西叫「本轮输出」。
 *
 * 滚动策略照抄编排器面板：默认跟到底部（这是一条流，最新一句必须在视野里），
 * 但人手动往上翻时必须让位，否则每来一条事件就把他拽回底部，什么都读不了。
 */
function NodeConversation({
  entries,
  echo,
}: {
  entries: ConversationEntry[];
  echo: string | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!stick.current) {
      return;
    }
    const node = scrollerRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries.length, echo]);

  const handleScroll = (): void => {
    const node = scrollerRef.current;
    if (!node) {
      return;
    }
    // 距底 48px 之内就算「还在跟着」：一点轻微回滚不该被当成「用户离开了底部」
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  if (entries.length === 0 && echo === null) {
    // 空态也要说话：一个什么都没显示的区域会被读成「这个功能坏了」，
    // 而它真实的含义是「还没有人跟这个节点说过话，它自己也没开始」
    return (
      <div className="mt-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line px-4 py-6 text-center">
        <MessageSquare aria-hidden="true" className="h-4 w-4 text-passive" />
        <p className="text-[11px] leading-5 text-muted">这个节点还没有会话。</p>
        <p className="text-[11px] leading-5 text-passive">
          它开始执行后，每一轮与你的插话都会记在这里。
        </p>
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      aria-live="polite"
      aria-label="节点会话"
      className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1"
    >
      <ul className="space-y-4">
        {entries.map((entry) => (
          <li key={entry.id}>
            <ConversationEntryItem
              entry={entry}
              interruptLabel="打断执行 · 按这句重来"
              outputsLabel="本轮输出"
            />
          </li>
        ))}
        {echo ? (
          <li>
            <QueuedHuman text={echo} />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * 会话输入区的三种语义。
 *
 * 与后端一一对应，不能只分「在跑 / 没在跑」两态：等人工审批的节点有
 * `startedAt` 却没有任何 Agent 进程，后端对它只记录不打断（真打断会把
 * 「待你审批」抹掉）。前端要是照着「在跑」说「发送会打断当前执行」，
 * 用户就会以为审批被掐了。
 */
type ComposerState = 'running' | 'waiting_approval' | 'idle';

/** 输入框下面那句说明：它必须说清「按下去会发生什么」。 */
const COMPOSER_HINTS: Record<ComposerState, string> = {
  running: '发送会打断当前执行，并按这条要求重跑这个节点。',
  waiting_approval: '它在等人工审批：发送只记录，审批通过后再次运行该节点时生效。',
  idle: '发送后会记录；下次运行该节点时它会进提示词。',
};

/** 输入框占位：与说明配套，一个说「会发生什么」，一个说「该写什么」。 */
const COMPOSER_PLACEHOLDERS: Record<ComposerState, string> = {
  running: '打断并告诉它要改什么…（Enter 发送，Shift+Enter 换行）',
  waiting_approval: '给这次审批补条要求…（Enter 发送，Shift+Enter 换行）',
  idle: '给这个节点留条要求…（Enter 发送，Shift+Enter 换行）',
};

/**
 * 会话输入区。
 *
 * 可用性按节点状态分成三句话，而且这三句话必须与后端行为一一对应——
 * 前端只要含糊一句「发送消息」，用户就分不清自己是在打断还是在留言。
 */
function NodeComposer({
  runId,
  nodeId,
  state,
  onEcho,
  onDone,
}: {
  runId: string;
  nodeId: string;
  /** 后端 NodeView.status 的投影，见 ComposerState */
  state: ComposerState;
  onEcho: (text: string | null) => void;
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || pending) {
      return;
    }

    setPending(true);
    setError(null);
    onEcho(text);
    setDraft('');

    const result = await sendNodeMessage(runId, nodeId, { text });
    setPending(false);

    if (!result) {
      // 网络层失败：后端没收到这句话，把文本还给人，别让他重打一遍
      onEcho(null);
      setDraft(text);
      setError('没有连上后端，这条消息没有发出去。');
      return;
    }

    // 无论「打断了」还是「只记录」，这句话与回执都已经落成事实，
    // 真实结果是会话里的两条记录，不该由这里猜
    onDone?.();
  };

  return (
    <div className="mt-2 shrink-0 border-t border-line pt-2">
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">给这个节点的消息</span>
          <textarea
            rows={2}
            value={draft}
            disabled={pending}
            placeholder={COMPOSER_PLACEHOLDERS[state]}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter 发送、Shift+Enter 换行。IME 组合中的 Enter 不能当发送——
              // 中文输入法选词会误触
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
            className="max-h-[120px] min-h-[56px] w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-5 text-ink placeholder:text-passive focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
          />
        </label>
        <button
          type="button"
          onClick={() => void send()}
          disabled={pending || draft.trim().length === 0}
          aria-label="发送给这个节点"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-white transition-colors hover:bg-zinc-800 disabled:pointer-events-none disabled:opacity-40"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
          ) : (
            <Send className="h-4 w-4" strokeWidth={2} />
          )}
        </button>
      </div>

      <div className="mt-1 flex items-center justify-between gap-3 text-[10px] leading-4">
        <span className={state === 'running' ? 'text-warning' : 'text-passive'}>
          {COMPOSER_HINTS[state]}
        </span>
        {pending ? (
          <span className="shrink-0 text-muted">已发送，正在处理…</span>
        ) : error ? (
          <span className="shrink-0 text-danger">{error}</span>
        ) : null}
      </div>
    </div>
  );
}

/** 头部的一格元信息：标签灰、数值实，中间用间隔点连起来而不是画分割线。 */
function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden="true" className="text-passive">
        ·
      </span>
      <span>{label}</span>
      <span className="tabular-nums text-ink">{value}</span>
    </span>
  );
}

/** 同一时刻只可能有一个节点级请求在飞。 */
type NodeAction = 'run' | 'stop' | 'reset';

/**
 * 每个动作失败时的那一句解释。
 *
 * 都不弹窗：这里不是「出大事了」的位置，一次没生效只需要在按钮旁边说一句，
 * 用户看一眼再点一次就好。
 */
const ACTION_FAILURES: Record<NodeAction, string> = {
  run: '没有跑起来：该节点可能正在执行，或后端没有响应。',
  stop: '停止请求没有成功：后端没有响应。',
  reset: '重置没有生效：该节点可能正在执行，或后端没有响应。',
};

/**
 * 节点动作区：运行 / 停止 / 重置。
 *
 * 为什么会出现在一个大面板的底部：这三种动作的对象都是「这一个节点」，
 * 而为了重跑一个节点去新建一整个运行，代价是把前面的执行事实全丢掉。
 *
 * 三个刻意的取舍：
 * - 待审批的状态不给「运行此节点」：那一步该走审批区，两处入口通向同一件事
 *   只会让人怀疑哪个才算数。
 * - 运行中只给「停止」：此刻重置会被随后回来的 node.completed 抹掉，
 *   后端也会用 409 拒绝，前端就不该把它摆出来。
 * - 危险动作静止时只是一个灰色文字按钮，hover / focus 才露红——但它是真按钮、
 *   真的可聚焦，键盘用户不必先把鼠标移上去才能发现它。
 */
function NodeActions({
  runId,
  nodeId,
  status,
  onDone,
}: {
  runId: string;
  nodeId: string;
  /** 展示态：interrupted 由 interruptedAt 推出，不参与任何调度判断 */
  status: NodeStatus;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState<NodeAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const running = status === 'running';
  const canRun =
    status === 'pending' ||
    status === 'ready' ||
    status === 'interrupted' ||
    status === 'failed' ||
    status === 'retry';

  async function dispatch(action: NodeAction) {
    setBusy(action);
    setError(null);
    const ok =
      action === 'run'
        ? await runNode(runId, nodeId)
        : action === 'stop'
          ? await stopNode(runId, nodeId)
          : await resetNode(runId, nodeId);
    setBusy(null);
    if (!ok) {
      // 后端没接上或拒绝了，都不谎报成功
      setError(ACTION_FAILURES[action]);
      return;
    }
    onDone?.();
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        {canRun ? (
          <Button
            size="sm"
            onClick={() => void dispatch('run')}
            disabled={busy !== null}
          >
            <Play className="h-3 w-3" strokeWidth={1.8} />
            {busy === 'run' ? '运行中…' : '运行此节点'}
          </Button>
        ) : null}

        {running ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void dispatch('stop')}
            disabled={busy !== null}
            className="text-passive hover:bg-danger-soft hover:text-danger focus-visible:ring-danger/40"
          >
            <Square className="h-3 w-3" strokeWidth={1.8} />
            {busy === 'stop' ? '停止中…' : '停止此节点'}
          </Button>
        ) : null}

        {running ? null : (
          <Button
            size="sm"
            variant="secondary"
            title="重置会清空这一轮的执行事实（跑完的下游一并作废），之后可以重新运行"
            onClick={() => void dispatch('reset')}
            disabled={busy !== null}
          >
            <RotateCcw className="h-3 w-3" strokeWidth={1.8} />
            {busy === 'reset' ? '重置中…' : '重置'}
          </Button>
        )}
      </div>

      {error ? (
        <p className="mt-1 text-[10px] leading-4 text-danger">{error}</p>
      ) : null}
    </div>
  );
}

/** 审批人。身份来自 zustand + localStorage，不再写死某个小组名。 */
function ApprovalActions({
  runId,
  node,
  onDone,
}: {
  runId: string;
  node: WorkflowNode;
  onDone?: () => void;
}) {
  const actor = useIdentity((state) => state.actor);
  const setActor = useIdentity((state) => state.setActor);
  const [reason, setReason] = useState('');
  const [handoffTo, setHandoffTo] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'handoff' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  async function submit(decision: 'approve' | 'reject' | 'handoff') {
    setBusy(decision);
    setError(null);
    const result = await decideApproval(runId, node.id, {
      decision,
      actor,
      reason: reason.trim() || undefined,
      handoffTo: decision === 'handoff' ? handoffTo.trim() : undefined,
    });
    setBusy(null);
    if (!result.ok) {
      // 后端没接上时不谎报成功
      setError(result.message);
      return;
    }
    setReason('');
    setHandoffTo('');
    onDone?.();
  }

  return (
    <div className="px-5 py-3">
      <div className="rounded-lg border border-warning/20 bg-warning-soft/70 p-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-warning">
          <ShieldAlert className="h-3.5 w-3.5" strokeWidth={1.8} />
          等待人工审批
        </div>
        <p className="mt-1.5 text-[10px] leading-4 text-muted">
          批准后推进下游。驳回会退回上游实现。转交后由接收人继续审批。
        </p>

        {/* 面板够宽，审批人和理由并排放，省一行高度留给时间线 */}
        <div className="mt-2.5 flex items-start gap-2">
          <label className="block w-[200px] shrink-0 text-[10px] text-passive">
            审批人
            <input
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              aria-label="审批人"
              className="mt-1 h-7 w-full rounded-md border border-line bg-surface px-2 text-[11px] text-ink placeholder:text-passive transition-colors focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          </label>
          <label className="block min-w-0 flex-1 text-[10px] text-passive">
            理由（可选）
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：接口契约没对齐，退回重做"
              aria-label="审批理由"
              className="mt-1 h-7 w-full rounded-md border border-line bg-surface px-2 text-[11px] text-ink placeholder:text-passive transition-colors focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          </label>
        </div>

        <label className="mt-2.5 block w-[200px] text-[10px] text-passive">
          转交给
          <input
            value={handoffTo}
            onChange={(event) => setHandoffTo(event.target.value)}
            className="mt-1 h-7 w-full rounded-md border border-line bg-surface px-2 text-[11px] text-ink"
          />
        </label>

        <div className="mt-2 flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => void submit('approve')}
            disabled={busy !== null}
          >
            {busy === 'approve' ? '提交中' : '批准'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void submit('reject')}
            disabled={busy !== null}
          >
            驳回
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void submit('handoff')}
            disabled={busy !== null || !handoffTo.trim()}
          >
            转交
          </Button>
        </div>

        {error ? (
          <p className="mt-2 text-[10px] leading-4 text-danger">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
