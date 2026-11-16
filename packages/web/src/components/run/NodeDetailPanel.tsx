import {
  GitBranch,
  Play,
  RotateCcw,
  ScrollText,
  ShieldAlert,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { decideApproval, resetNode, runNode, stopNode } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { useIdentity } from '../../lib/identity-store';
import { displayNodeStatus, nodeStatusMeta, nodeTypeMeta } from '../../lib/workflow-meta';
import type {
  NodeStatus,
  WorkflowNode,
  WorkflowRunDetail,
} from '../../types/workflow';
import { AgentChip } from '../agents/AgentChip';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CollapsibleText } from '../ui/CollapsibleText';
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

/** 可聚焦元素选择器：焦点陷阱用它算首尾，和浏览器 Tab 顺序一致。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
      if (event.key !== 'Tab') {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        return;
      }
      const active = document.activeElement;
      // 首帧焦点在面板容器上（不是第一个可聚焦元素），从那里 Shift+Tab
      // 会直接溜到背后的页面里，所以把容器也当成「第一个之前」
      if (event.shiftKey) {
        if (active === first || active === panel || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
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

        {/* 主体：时间线吃掉全部剩余高度，滚动交给它自己 */}
        <section className="flex min-h-0 flex-1 flex-col px-5 pb-3 pt-3">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
              <ScrollText className="h-3 w-3" strokeWidth={1.8} />
              执行时间线
            </h3>
            <span className="text-[10px] tabular-nums text-passive">
              {nodeEvents.length} 条事件
            </span>
          </div>

          {/* key 绑 node.id：切节点时把「哪些长条目被展开」重置掉，
              否则上一条输出的展开状态会串到下一个节点 */}
          <NodeTimeline
            key={node.id}
            runId={run.id}
            node={node}
            events={nodeEvents}
            variant="roomy"
          />
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
    });
    setBusy(null);
    if (!result) {
      // 后端没接上时不谎报成功
      setError('后端未响应，审批没有提交。');
      return;
    }
    setReason('');
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
          批准推进下游；驳回把上游「{node.dependsOn[0] ?? '无依赖'}」退回重做，
          已跑完的下游一并作废；转交追加一条新的审批记录。
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
            disabled={busy !== null}
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
