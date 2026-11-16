import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  FileDiff,
  Gauge,
  Info,
  Loader2,
  Play,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  UserCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchNodeArtifact, type NodeArtifactView } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatClock, formatDuration } from '../../lib/format';
import { displayNodeStatus, thinkingMeta } from '../../lib/workflow-meta';
import type {
  AgentEventKind,
  NodeStatus,
  WorkflowEvent,
  WorkflowNode,
} from '../../types/workflow';
import { AgentChip } from '../agents/AgentChip';

/**
 * 节点执行时间线：把「这一轮干了什么」按发生顺序铺成一条会话记录。
 *
 * 时间列在左、内容在右，一条一条往下读——这是节点详情该有的形态。
 * 元信息表只能回答「花了多久」，回答不了「它先想了什么、调了什么、
 * 改了哪些文件、最后怎么结束的」。
 *
 * 数据来源分两处，刻意如此：
 * - 正文/工具/结果/错误来自事件，由调用方从 `run.events` 里按 nodeId 过滤后
 *   传进来（零请求，SSE 每刷新一次运行详情就跟着更新）。
 * - 文件变更的 diff 原文只存在于磁盘，必须回后端要一次；事件里那条
 *   `node.artifact` 一行只带采集时刻的旧统计量，见下方 buildTimeline 的说明。
 */

/** 单次展开渲染的 diff 行数上限：几千个 DOM 节点会把检查器拖到输不进字。 */
const MAX_DIFF_LINES = 400;

/** 超过这个长度或超过三行才值得给展开按钮，短消息点了没反应更让人困惑。 */
const TEXT_COLLAPSE_CHARS = 120;

/**
 * 时间线的疏密档位。
 *
 * 时间线原来只长在 320px 右栏里，于是把 11px 字号、紧凑行距、三行折叠都写死
 * 在了渲染里。搬到 880px 的大面板后同一套密度会让正文看起来很挤——这不是
 * 「换一套视觉」，而是同一个组件在两种画布宽度下的排版参数：时间列、语义圆点、
 * 等宽 diff 着色完全一致，只放大行距、字号、折叠阈值和 diff 可视高度。
 */
interface TimelineDensity {
  /** 单条记录的内边距：决定两条输出之间的呼吸感 */
  row: string;
  /** 时间列宽度：roomy 下 HH:mm:ss 用 11px 排得开，不需要再挤 */
  timeWidth: string;
  timeSize: string;
  /** 正文（输出、工具名、开始/结束行） */
  body: string;
  /** 次级说明（失败原因、折叠按钮、diff 脚注） */
  meta: string;
  /** 正文默认展开几行；超过就折叠 */
  clampLines: 3 | 6;
  /** 折算成字符的折叠门槛：窄栏里 120 字已经很长，宽栏能舒服地放更多 */
  collapseChars: number;
  /** diff 区最大高度 */
  diffMaxHeight: string;
}

const DENSITIES: Record<'compact' | 'roomy', TimelineDensity> = {
  compact: {
    row: 'py-1',
    timeWidth: 'w-[46px]',
    timeSize: 'text-[10px]',
    body: 'text-[11px] leading-4',
    meta: 'text-[10px] leading-4',
    clampLines: 3,
    collapseChars: TEXT_COLLAPSE_CHARS,
    diffMaxHeight: 'max-h-[200px]',
  },
  roomy: {
    row: 'py-2',
    timeWidth: 'w-[62px]',
    timeSize: 'text-[11px]',
    body: 'text-[13px] leading-6',
    meta: 'text-[11px] leading-5',
    clampLines: 6,
    collapseChars: 240,
    diffMaxHeight: 'max-h-[360px]',
  },
};

/** line-clamp 的类名必须静态写全，Tailwind 不认拼接出来的类。 */
const CLAMP_CLASS: Record<2 | 3 | 6, string> = {
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  6: 'line-clamp-6',
};

/**
 * 思考块默认只露两行。
 *
 * 它比正文更该收起：读者需要的是「它想过这件事」，而不是逐字读它的推演。
 * 两行足够看出一段思考在讨论什么，愿意深究再点开。
 */
const THINKING_CLAMP_LINES = 2;

/** 一条时间线条目。key 用事件 id，SSE 重写时原地更新而不是重新挂载。 */
type TimelineItem =
  | { key: string; kind: 'start'; at?: string }
  | { key: string; kind: 'files'; at?: string }
  | { key: string; kind: 'end'; at?: string; message?: string }
  | { key: string; kind: 'note'; at: string; event: WorkflowEvent }
  | { key: string; kind: AgentEventKind; at: string; event: WorkflowEvent };

/** 事件按发生时刻升序。同一毫秒内保持后端给出的相对顺序。 */
function byTime(left: WorkflowEvent, right: WorkflowEvent): number {
  return new Date(left.at).getTime() - new Date(right.at).getTime();
}

type Boundary = 'start' | 'end' | 'artifact';

/**
 * 认出一条事件是不是这一轮的结构性边界。
 *
 * 只能按文案认：`EventView` 只保留折过的 `type`（stage/agent/…），原始的
 * `OrchestratorEvent.type` 在 core 的 deriveEvents 里就被抹平了，前端拿不到
 * 「这条是 node.started 还是 node.completed」。这些文案由 core 用节点标题
 * 拼出来（见 packages/core/src/derive.ts），是稳定契约。
 *
 * 带 `kind` 的事件一定是 agent.output，也就是正文，绝不当边界。
 */
function boundaryOf(node: WorkflowNode, event: WorkflowEvent): Boundary | undefined {
  if (event.kind) {
    return undefined;
  }
  const title = node.title;
  if (event.message === `${title} 开始执行`) {
    return 'start';
  }
  if (
    event.message === `${title} 完成` ||
    event.message.startsWith(`${title} 失败：`) ||
    event.message.startsWith(`${title} 被退回重做：`) ||
    // 「被停止：<节点名>（<原因>）」——节点名不在句首，所以要按前缀单独认
    event.message.startsWith(`被停止：${title}（`)
  ) {
    return 'end';
  }
  if (event.message.startsWith(`${title} 产出 `)) {
    // 文件变更条目会用磁盘上那份 diff 现算的数字说话，比这条事件里的快照准
    return 'artifact';
  }
  return undefined;
}

/** 节点是否已经跑过（跑过才有开始/结束两行，待定节点只有一句空状态）。 */
function hasStarted(node: WorkflowNode): boolean {
  // 用展示态：被用户停下、后端仍是 ready 的节点已经跑过一次了，
  // 它需要「开始执行 → 已停止（可继续）」这两行才能解释发生了什么
  const status = displayNodeStatus(node);
  return status !== 'pending' && status !== 'ready';
}

/**
 * 把这节点的事件铺成时间线。
 *
 * 首尾两行由节点事实（状态、耗时）决定而不是从事件里捞：重放、旧数据、或者
 * 事件日志被截断时，节点状态一定还在，而事件可能一条都不剩。
 */
function buildTimeline(node: WorkflowNode, events: WorkflowEvent[]): TimelineItem[] {
  if (!hasStarted(node) && events.length === 0) {
    return [];
  }

  const body: TimelineItem[] = [];
  let startAt: string | undefined;
  let endAt: string | undefined;
  let endMessage: string | undefined;
  let artifactAt: string | undefined;

  for (const event of [...events].sort(byTime)) {
    const boundary = boundaryOf(node, event);
    if (boundary === 'start') {
      startAt = event.at;
      continue;
    }
    if (boundary === 'end') {
      endAt = event.at;
      endMessage = event.message;
      continue;
    }
    if (boundary === 'artifact') {
      artifactAt = event.at;
      continue;
    }
    if (event.kind === 'status') {
      // 进度信号不是内容：编排层已经不落它，历史事件里可能还留着。
      // 前端也不给它留位置——一条「它进行到第几步」在时间线上没有读者
      continue;
    }
    if (event.kind === 'thinking' && !event.message.trim()) {
      // 空思考块一个字都没说，渲染出来只是一块空白缩进
      continue;
    }
    body.push(
      event.kind
        ? { key: event.id, kind: event.kind, at: event.at, event }
        : { key: event.id, kind: 'note', at: event.at, event },
    );
  }

  const items: TimelineItem[] = [];
  if (hasStarted(node)) {
    // 没有开始事件时退到首条事件时刻：宁可差一点，也不要时间列空一格
    items.push({ key: 'start', kind: 'start', at: startAt ?? body[0]?.at });
  }
  items.push(...body);
  if (hasStarted(node)) {
    // 变更插在「完成」之前：文件是这一轮的产物，不是结束之后的余波
    items.push({ key: 'files', kind: 'files', at: artifactAt ?? endAt });
    items.push({ key: 'end', kind: 'end', at: endAt, message: endMessage });
  }
  return items;
}

/** 一行时间线：左侧细时间列，中间语义色圆点，右侧内容。 */
function TimelineRow({
  at,
  tone,
  density,
  children,
}: {
  at?: string;
  /** 圆点色，语义与这一行说的事情一致 */
  tone: string;
  density: TimelineDensity;
  children: ReactNode;
}) {
  return (
    <li className={cn('flex items-start gap-2', density.row)}>
      <span
        className={cn(
          'shrink-0 pt-px tabular-nums text-passive',
          density.timeWidth,
          density.timeSize,
        )}
      >
        {at ? formatClock(at) : '—'}
      </span>
      <span
        aria-hidden="true"
        className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', tone)}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/** 正文是否长到需要折叠。默认行数以内能一眼看完，折叠反而是噪音。 */
function needsCollapse(
  message: string,
  maxLines: number,
  maxChars: number,
): boolean {
  return message.length > maxChars || message.split('\n').length > maxLines;
}

/**
 * 可折叠正文。
 *
 * 节点输出经常是整段 markdown 或一整块代码，默认铺开会把时间线拉成一堵墙；
 * 折叠到几行后，读的人先看见「说了什么」的轮廓，愿意细看再点开。
 */
function CollapsibleText({
  text,
  className,
  density,
  clampLines,
  expanded,
  onToggle,
}: {
  text: string;
  className?: string;
  density: TimelineDensity;
  /** 覆盖默认折叠行数：思考块比正文更该收起 */
  clampLines?: 2 | 3 | 6;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lines = clampLines ?? density.clampLines;
  const collapsible = needsCollapse(text, lines, density.collapseChars);
  const open = expanded || !collapsible;

  return (
    <div className="min-w-0">
      <div
        className={cn(
          'whitespace-pre-wrap break-words',
          density.body,
          !open && CLAMP_CLASS[lines],
          className,
        )}
      >
        {text}
      </div>
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            'mt-0.5 inline-flex items-center gap-0.5 text-passive transition-colors hover:text-ink',
            density.meta,
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('h-2.5 w-2.5 transition-transform', open && 'rotate-90')}
            strokeWidth={2}
          />
          {open ? '收起' : '展开'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 思考块。
 *
 * 组织方式借用左侧竖线表达层级：2px 竖线 + 缩进说明「这段内容从属于刚才那个
 * 动作，但它不是结论」。标题只说状态（进行中 / 已完毕），正文用 muted 并且
 * 默认折到两行——扫读的人只要认出「这里它在想」就能跳过，不必逐字读推演。
 *
 * 空内容在 buildTimeline 阶段就被滤掉了，所以这里不必再判空。
 */
function ThinkingBlock({
  text,
  live,
  density,
  expanded,
  onToggle,
}: {
  text: string;
  /** 这一轮尚未落定：标题说「思考中」并配一个转圈 */
  live: boolean;
  density: TimelineDensity;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = thinkingMeta;
  const Icon = meta.icon;

  return (
    <div className={cn('min-w-0 border-l-2 pl-2.5', meta.rail)}>
      <div className={cn('flex items-center gap-1.5', density.meta)}>
        <Icon
          aria-hidden="true"
          className={cn('h-3 w-3 shrink-0', meta.iconText)}
          strokeWidth={1.8}
        />
        <span className={cn('shrink-0', meta.text)}>
          {live ? meta.runningLabel : meta.settledLabel}
        </span>
        {live ? (
          <Loader2
            aria-label="仍在思考"
            className="h-2.5 w-2.5 shrink-0 animate-spin text-passive"
          />
        ) : null}
      </div>
      <CollapsibleText
        text={text}
        className={cn('mt-0.5', meta.text)}
        density={density}
        clampLines={THINKING_CLAMP_LINES}
        expanded={expanded}
        onToggle={onToggle}
      />
    </div>
  );
}

/**
 * 用量的一行紧凑读法。
 *
 * core 写的是给审计看的完整句（「token 用量：输入 1200 / 输出 300 / 合计 1500」），
 * 时间线上它只值一眼：进去多少、出来多少。抽不到数字就原样显示——文案由 core
 * 生成，前端不猜它的格式。
 */
function formatUsageLine(message: string): string {
  const prompt = /输入\s*([\d,]+)/.exec(message)?.[1];
  const completion = /输出\s*([\d,]+)/.exec(message)?.[1];
  if (!prompt || !completion) {
    return message;
  }
  return `${compactTokens(prompt)} → ${compactTokens(completion)} tokens`;
}

function compactTokens(raw: string): string {
  const value = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(value)) {
    return raw;
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** 单行 diff 上色：只认行首标记，不做语法高亮——diff 要的是增删一眼可辨。 */
function diffLineClass(line: string): string {
  if (line.startsWith('@@')) {
    return 'text-accent';
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-passive';
  }
  if (line.startsWith('+')) {
    return 'text-success';
  }
  if (line.startsWith('-')) {
    return 'text-danger';
  }
  return 'text-muted';
}

/** diff 原文：等宽、横向滚动、保留换行，行首标记决定颜色。 */
function DiffBlock({
  diff,
  density,
}: {
  diff: string;
  density: TimelineDensity;
}) {
  const { visible, total } = useMemo(() => {
    const all = diff.split('\n');
    // 尾部换行会多出一个空行，去掉它以免看起来像「diff 结束有空行」
    if (all.at(-1) === '') {
      all.pop();
    }
    return { visible: all.slice(0, MAX_DIFF_LINES), total: all.length };
  }, [diff]);

  return (
    <div className="mt-1 overflow-hidden rounded-md border border-line bg-subtle/30">
      <div className={cn('overflow-auto', density.diffMaxHeight)}>
        <pre
          className={cn(
            'w-max min-w-full p-2 font-mono',
            density.meta,
            // diff 是代码，行高固定不跟随正文字号，否则纵向对齐会散
            'leading-4',
          )}
        >
          {visible.map((line, index) => (
            <div key={index} className={diffLineClass(line)}>
              {line === '' ? ' ' : line}
            </div>
          ))}
        </pre>
      </div>
      {total > visible.length ? (
        <p
          className={cn(
            'border-t border-line px-2 py-1 text-passive',
            density.meta,
          )}
        >
          仅显示前 {MAX_DIFF_LINES} 行，共 {total} 行
        </p>
      ) : null}
    </div>
  );
}

type ArtifactState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; view: NodeArtifactView }
  | { status: 'empty' };

/**
 * 文件变更条目。
 *
 * diff 原文从来不进前端内存（也刻意不进事件日志），只能回后端要一次。默认
 * 收起：一份真实 diff 动辄几百行，直接铺开会把整个时间线顶下去。
 *
 * 404 与加载失败都落到「该节点没有产出变更」——没起后端时请求同样失败，而
 * 「没有产出」是绝大多数情况下的真相，弹错误只会误导。
 */
function FilesEntry({
  artifact,
  running,
  density,
  expanded,
  onToggle,
}: {
  artifact: ArtifactState;
  running: boolean;
  density: TimelineDensity;
  expanded: boolean;
  onToggle: () => void;
}) {
  const view = artifact.status === 'ready' ? artifact.view : null;
  const summary =
    artifact.status === 'idle' || artifact.status === 'loading'
      ? '读取中…'
      : view
        ? `${view.files.length} 个文件 · ${view.bytes} 字节`
        : running
          ? '暂无产出变更'
          : '该节点没有产出变更';

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onToggle}
        disabled={!view}
        aria-expanded={view ? expanded : undefined}
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          density.body,
          view
            ? 'text-ink transition-colors hover:text-accent'
            : 'cursor-default text-muted',
        )}
      >
        <FileDiff
          aria-hidden="true"
          className="h-3 w-3 shrink-0 text-muted"
          strokeWidth={1.8}
        />
        <span className="min-w-0 truncate">{summary}</span>
        {view ? (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'h-3 w-3 shrink-0 text-passive transition-transform',
              expanded && 'rotate-90',
            )}
            strokeWidth={1.8}
          />
        ) : null}
      </button>

      {view && expanded ? (
        <div className="mt-1 min-w-0">
          {view.files.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {view.files.map((file) => (
                <code
                  key={file}
                  className="max-w-full truncate rounded border border-line bg-subtle/60 px-1.5 py-0.5 font-mono text-[10px] text-muted"
                >
                  {file}
                </code>
              ))}
            </div>
          ) : null}
          <DiffBlock diff={view.diff} density={density} />
        </div>
      ) : null}
    </div>
  );
}

/** 收尾一行的语义：状态色与文案都从节点状态来，不从事件文案猜。 */
const endMeta: Record<
  NodeStatus,
  { label: string; tone: string; text: string; icon: LucideIcon }
> = {
  completed: {
    label: '完成',
    tone: 'bg-success',
    text: 'text-success',
    icon: CheckCircle2,
  },
  failed: {
    label: '失败',
    tone: 'bg-danger',
    text: 'text-danger',
    icon: AlertTriangle,
  },
  waiting_approval: {
    label: '等待人工审批',
    tone: 'bg-warning',
    text: 'text-warning',
    icon: UserCheck,
  },
  retry: {
    label: '已退回重做',
    tone: 'bg-coral',
    text: 'text-coral',
    icon: RotateCcw,
  },
  interrupted: {
    // warning 而不是 danger：这不是「这里坏了」，是「人把它按停了，随时能接上」。
    // 用失败色会让用户去做排障，而正确动作是点继续。
    label: '已停止（可继续）',
    tone: 'bg-warning',
    text: 'text-warning',
    icon: CircleSlash,
  },
  running: {
    label: '执行中',
    tone: 'bg-accent animate-pulse',
    text: 'text-accent',
    icon: Loader2,
  },
  pending: {
    label: '尚未开始',
    tone: 'bg-passive',
    text: 'text-passive',
    icon: Play,
  },
  ready: {
    label: '排队等待',
    tone: 'bg-passive',
    text: 'text-passive',
    icon: Play,
  },
};

/** 附注行的图标：用量、会话各有一个，其余按事件归到哪一页签来定。 */
function noteIcon(
  event: WorkflowEvent,
  kind: AgentEventKind | undefined,
): LucideIcon {
  if (kind === 'usage') {
    return Gauge;
  }
  if (kind === 'session') {
    return ScrollText;
  }
  if (event.type === 'review') {
    return ShieldCheck;
  }
  if (event.type === 'approval') {
    return UserCheck;
  }
  return Info;
}

export interface NodeTimelineProps {
  runId: string;
  node: WorkflowNode;
  /** 该节点的事件，调用方已按 nodeId 过滤好（见 NodeDetailPanel） */
  events: WorkflowEvent[];
  /**
   * 疏密档位。
   *
   * compact 保留给窄栏（自带 280px 上限、自己滚）；roomy 给大面板：不再限制
   * 高度，改为 `flex-1 min-h-0`，由父容器决定它吃多少空间，滚动交给它自己。
   */
  variant?: 'compact' | 'roomy';
  className?: string;
}

export function NodeTimeline({
  runId,
  node,
  events,
  variant = 'compact',
  className,
}: NodeTimelineProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [artifact, setArtifact] = useState<ArtifactState>({ status: 'idle' });
  const density = DENSITIES[variant];

  const running =
    node.status === 'running' || node.status === 'waiting_approval';

  const started = hasStarted(node);

  useEffect(() => {
    // 没跑过的节点不可能有产物，别为待定节点白跑一趟
    if (!started) {
      setArtifact({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setArtifact({ status: 'loading' });

    void fetchNodeArtifact(runId, node.id).then((view) => {
      // 切节点后旧请求可能才回来，落地前先确认这次结果还属于当前节点
      if (cancelled) {
        return;
      }
      setArtifact(view ? { status: 'ready', view } : { status: 'empty' });
    });

    return () => {
      cancelled = true;
    };
    // 依赖只用 id 与「是否已开始」：node 对象每次 SSE 刷新都是新引用，
    // 直接依赖它会让运行详情每推一条事件就重发一次 diff 请求
  }, [runId, node.id, started]);

  const items = useMemo(() => buildTimeline(node, events), [node, events]);

  /**
   * 最后一条「有内容」的条目下标。
   *
   * 只有它可能是「仍在思考」：节点停下来之后，最后一条思考就是这一轮的结论，
   * 再给个转圈图标会让人以为它还活着。
   */
  const lastContentIndex = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const kind = items[index]?.kind;
      if (
        kind === 'thinking' ||
        kind === 'text' ||
        kind === 'tool' ||
        kind === 'result' ||
        kind === 'error'
      ) {
        return index;
      }
    }
    return -1;
  }, [items]);

  const toggle = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: prev[key] !== true }));
  };

  if (items.length === 0) {
    return (
      <p className={cn('mt-2 text-passive', density.body)}>
        该节点还没有输出。
      </p>
    );
  }

  return (
    <ol
      className={cn(
        'mt-2',
        variant === 'compact'
          ? // 窄栏：自己给自己一个上限，右栏剩下的高度不可控
            'max-h-[280px] overflow-y-auto pr-0.5'
          : // 大面板：不限高，撑满父容器后自己滚，滚动条离正文留一点距离
            'min-h-0 flex-1 overflow-y-auto pr-1',
        className,
      )}
    >
      {items.map((item, index) => {
        if (item.kind === 'start') {
          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone="bg-accent"
              density={density}
            >
              <div
                className={cn(
                  'flex min-w-0 items-center gap-1.5 text-ink',
                  density.body,
                )}
              >
                <Play
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 text-accent"
                  strokeWidth={1.8}
                />
                <span className="shrink-0">开始执行</span>
                <AgentChip
                  agentId={node.agentId}
                  label={node.agent}
                  className="min-w-0 text-muted"
                  iconClassName="h-3 w-3"
                />
              </div>
            </TimelineRow>
          );
        }

        if (item.kind === 'files') {
          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone="bg-line-strong"
              density={density}
            >
              <FilesEntry
                artifact={artifact}
                running={running}
                density={density}
                expanded={expanded[item.key] === true}
                onToggle={() => toggle(item.key)}
              />
            </TimelineRow>
          );
        }

        if (item.kind === 'end') {
          const status = displayNodeStatus(node);
          const meta = endMeta[status];
          const Icon = meta.icon;
          // 失败原因只在事件里有（node 事实只记「失败了」不记为什么）。
          // 被停止是同一类信息：状态说「停下了」，事件才说「为什么」。
          const reason =
            status === 'failed' && item.message
              ? item.message.replace(/^.*?失败：/, '')
              : status === 'interrupted' && item.message
                ? /^被停止：.*?（(.+)）$/.exec(item.message)?.[1]
                : undefined;

          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone={meta.tone}
              density={density}
            >
              <div
                className={cn(
                  'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5',
                  density.body,
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn('h-3 w-3 shrink-0', meta.text)}
                  strokeWidth={1.8}
                />
                <span className={cn('shrink-0 font-medium', meta.text)}>
                  {meta.label}
                </span>
                {node.durationMs ? (
                  <span className="shrink-0 tabular-nums text-passive">
                    · {formatDuration(node.durationMs)}
                  </span>
                ) : null}
              </div>
              {reason ? (
                <p
                  className={cn(
                    'mt-0.5 whitespace-pre-wrap break-words text-muted',
                    density.meta,
                  )}
                >
                  {reason}
                </p>
              ) : null}
            </TimelineRow>
          );
        }

        const open = expanded[item.key] === true;

        if (item.kind === 'thinking') {
          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone="bg-line-strong"
              density={density}
            >
              <ThinkingBlock
                text={item.event.message}
                live={running && index === lastContentIndex}
                density={density}
                expanded={open}
                onToggle={() => toggle(item.key)}
              />
            </TimelineRow>
          );
        }

        if (item.kind === 'tool') {
          const toolName = item.event.toolName ?? '工具调用';
          // 摘要可能就等于工具名（解析器没取到入参），重复显示两遍没有意义
          const summary =
            item.event.message !== toolName ? item.event.message : undefined;
          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone="bg-review"
              density={density}
            >
              {/* 一行到底：工具调用是一件事，不是一段话。输出内容不在这里展开 */}
              <div
                className={cn(
                  'flex min-w-0 items-center gap-1.5',
                  density.body,
                )}
              >
                <Wrench
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 text-review"
                  strokeWidth={1.8}
                />
                <span className="shrink-0 font-mono font-medium text-review">
                  {toolName}
                </span>
                {summary ? (
                  <span className="min-w-0 truncate font-mono text-passive">
                    {summary}
                  </span>
                ) : null}
              </div>
            </TimelineRow>
          );
        }

        if (item.kind === 'text') {
          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone="bg-passive"
              density={density}
            >
              <CollapsibleText
                text={item.event.message}
                className="text-ink"
                density={density}
                expanded={open}
                onToggle={() => toggle(item.key)}
              />
            </TimelineRow>
          );
        }

        if (item.kind === 'result' || item.kind === 'error') {
          const failed = item.kind === 'error';
          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone={failed ? 'bg-danger' : 'bg-success'}
              density={density}
            >
              <div className="flex min-w-0 items-start gap-1.5">
                {failed ? (
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-px h-3 w-3 shrink-0 text-danger"
                    strokeWidth={1.8}
                  />
                ) : (
                  <CheckCircle2
                    aria-hidden="true"
                    className="mt-px h-3 w-3 shrink-0 text-success"
                    strokeWidth={1.8}
                  />
                )}
                <CollapsibleText
                  text={item.event.message}
                  className={failed ? 'text-danger' : 'text-success'}
                  density={density}
                  expanded={open}
                  onToggle={() => toggle(item.key)}
                />
              </div>
            </TimelineRow>
          );
        }

        if (item.kind === 'usage') {
          // 用量不是内容，是账目：一行小字，不占正文的高度
          return (
            <TimelineRow
              key={item.key}
              at={item.at}
              tone="bg-line-strong"
              density={density}
            >
              <div
                className={cn(
                  'flex min-w-0 items-center gap-1 text-passive',
                  density.meta,
                )}
              >
                <Gauge
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0"
                  strokeWidth={1.8}
                />
                <span className="truncate tabular-nums">
                  {formatUsageLine(item.event.message)}
                </span>
              </div>
            </TimelineRow>
          );
        }

        // 剩下的都是没有正文意义的附注行：会话 id，以及合并、审查结论、
        // 审批这类结构性事实。它们各有语义，但都只值一行灰字。
        const detailKind: AgentEventKind | undefined =
          item.kind === 'note' ? undefined : item.kind;
        const NoteIcon = noteIcon(item.event, detailKind);
        return (
          <TimelineRow
            key={item.key}
            at={item.at}
            tone="bg-line-strong"
            density={density}
          >
            <div
              className={cn(
                'flex min-w-0 items-start gap-1.5 text-muted',
                density.body,
              )}
            >
              <NoteIcon
                aria-hidden="true"
                className="mt-px h-3 w-3 shrink-0 text-passive"
                strokeWidth={1.8}
              />
              <CollapsibleText
                text={item.event.message}
                className="text-muted"
                density={density}
                expanded={open}
                onToggle={() => toggle(item.key)}
              />
            </div>
          </TimelineRow>
        );
      })}
    </ol>
  );
}
