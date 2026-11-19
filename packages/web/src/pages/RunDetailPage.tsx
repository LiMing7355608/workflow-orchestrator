import { AlertTriangle, GitBranch, Loader2, MessageSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EventStream } from '../components/run/EventStream';
import { NodeDetailPanel } from '../components/run/NodeDetailPanel';
import { NodeInspector } from '../components/run/NodeInspector';
import { PlanningSteps, PlanReviewPanel, RunPlanPanel } from '../components/run/PlanReviewPanel';
import { OrchestratorPanel } from '../components/run/OrchestratorPanel';
import { RunBoard } from '../components/run/RunBoard';
import { RunBlackboard } from '../components/run/RunBlackboard';
import { RunHeader } from '../components/run/RunHeader';
import { ViewBar, type RunView } from '../components/run/ViewBar';
import { WorkflowCanvas } from '../components/run/WorkflowCanvas';
import { Button, buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { getRunDetail } from '../data/run-detail';
import { fetchRunDetail } from '../lib/api';
import { useApiResource, useLiveRefresh } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';
import type { PlanFailure } from '../types/workflow';

/**
 * 右栏只留运行级概览。
 *
 * 编排器对话不再挤在这一列里（它原来靠 Segmented 与本概览二选一）：那段对话
 * 是本次运行的主线，一条被截成 320px 宽、还要和概览抢位置的时间线，读不出
 * 「一路聊过来」这件事。现在它有自己的大面板（OrchestratorPanel），入口是
 * 右栏顶部那个常驻按钮——概览与对话各自完整，谁也不挤谁。
 */

/**
 * 失败原因压成一段话。
 *
 * 主因在前，Planner 给的校验问题跟在后面——那些问题才是「改哪儿能重来」的
 * 线索，只留一句「拆解失败」等于让用户再猜一次。最多带两条：这种空态是用来
 * 读的，不是用来摊日志的。
 */
function failureText(failure: PlanFailure): string {
  const issues = (failure.issues ?? []).slice(0, 2).map((issue) => issue.message);
  return issues.length > 0
    ? `${failure.message}；${issues.join('；')}`
    : failure.message;
}

export function RunDetailPage() {
  const { runId } = useParams();
  const fallback = useMemo(() => getRunDetail(runId ?? '') ?? null, [runId]);
  const {
    data: run,
    source,
    loading,
    reload,
  } = useApiResource(() => fetchRunDetail(runId ?? ''), fallback);
  useLiveRefresh(source === 'live', reload, { runId });

  /**
   * 图还没生出来。
   *
   * 判据是「阶段 + 节点数」，而不是 status：`orchestrate` 表示编排器正在拆解，
   * `decompose` 是旧日志里同一个阶段的写法，一并兼容。此时渲染空看板会被读成
   * 「这个运行没有任务」，与事实正好相反——任务图正在生成。
   */
  const planning =
    run !== null &&
    (run.stage === 'orchestrate' || run.stage === 'decompose') &&
    run.nodes.length === 0;
  // 失败态只在「还没图」时成立：图一旦冻出来，那次失败就只是历史
  const planFailure = planning ? run?.planFailure : undefined;
  const planningActive = planning && run?.status === 'draft';

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // 面板自己记住「正在看哪个节点」而不仅仅依赖 selectedNodeId：关掉面板时
  // 高亮要留在图上（用户还在看这个节点），两者的生命周期并不相同。
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<RunView>('graph');
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const [draftLogOpen, setDraftLogOpen] = useState(false);

  usePageTitle(run?.title ?? '运行详情');

  useEffect(() => {
    setSelectedNodeId(null);
    setDetailNodeId(null);
    setActiveView('graph');
    setDraftLogOpen(false);
    setOrchestratorOpen(false);
  }, [runId]);

  /**
   * 拆解期间的兜底轮询。
   *
   * SSE 订阅是在「已经拿到过真实数据」之后才建立的（见 useLiveRefresh 的
   * enabled），从跳进详情页到那一刻有几十毫秒的窗口。规划要几十秒，落在那个
   * 窗口里的概率很低——但真落进去，用户就会永远停在「正在拆解」。所以这一段
   * 自己再拉一次：图一到手（或失败）planning 变 false，定时器立刻停。
   *
   * 走 ref 而不是把 reload 塞进依赖：useApiResource 每次渲染都返回一个新函数，
   * 直接依赖它等于每渲染一次就重建一个定时器。
   */
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    setDraftLogOpen(false);
  }, [run?.planDraft?.revision]);
  useEffect(() => {
    if (!planningActive) {
      return;
    }
    const timer = window.setInterval(() => reloadRef.current(), 2_000);
    return () => window.clearInterval(timer);
  }, [planningActive]);

  // 点节点即打开详情面板：拓扑图、泳道卡片、事件流、右栏概览里的条目都走
  // 这一条。详情足够大，遮住的是「宽高都很宽裕的画布」而不是用户正在读的
  // 那段文字——关掉就回来，状态一点没丢。
  const selectNode = (nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    setDetailNodeId(nodeId);
  };

  // 关闭只收面板，不撤销高亮：读完了图上的选择仍然有效，再点一下就回来
  const closeDetail = () => setDetailNodeId(null);

  if (!run) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
        <Card>
          {/* 刚建完就跳过来时第一次请求还在路上：这时说「找不到」是句假话，
              也正是「点了开始拆解却像没反应」的一部分 */}
          {loading ? (
            <EmptyState
              icon={Loader2}
              title="正在打开运行…"
              description="正在读取这个运行的事实。"
            />
          ) : (
            <EmptyState
              icon={GitBranch}
              title="找不到这个运行"
              description="它可能已经被删除，或者链接不完整。"
              action={
                <Link
                  to="/runs"
                  className={buttonStyles({ variant: 'secondary', size: 'sm' })}
                >
                  返回运行记录
                </Link>
              }
            />
          )}
        </Card>
      </div>
    );
  }

  const selectedNode = selectedNodeId
    ? (run.nodes.find((node) => node.id === selectedNodeId) ?? null)
    : null;

  // 面板绑 detailNodeId 而不是 selectedNodeId：关掉面板后高亮还在，
  // 但浮层必须消失
  const detailNode = detailNodeId
    ? (run.nodes.find((node) => node.id === detailNodeId) ?? null)
    : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden max-[1100px]:block max-[1100px]:h-auto max-[1100px]:overflow-visible">
      <RunHeader
        run={run}
        // 停止 / 继续成功后回读一次：状态由后端派生，前端不自己猜结果
        onRunChanged={reload}
        className="shrink-0 border-b border-line"
      />

      <ViewBar
        value={planning ? run.planDraft && !draftLogOpen ? 'plan' : 'events' : activeView}
        planning={planning}
        draft={Boolean(run.planDraft)}
        onChange={(view) => planning ? setDraftLogOpen(view === 'events') : setActiveView(view)}
        nodeCount={run.nodes.length}
        eventCount={run.events.length}
      />

      <div className="flex min-h-0 flex-1 max-[1100px]:block">
        <div className="min-w-0 flex-1 max-[1100px]:h-[560px]">
          {run.planDraft && !draftLogOpen ? (
            <PlanReviewPanel key={run.planDraft.revision} runId={run.id} revision={run.planDraft.revision}
              at={run.planDraft.at} paused={run.status === 'paused'} onCommit={reload} onDiscuss={() => setOrchestratorOpen(true)} />
          ) : planning ? (
            <div className="flex h-full flex-col bg-canvas">
              {run.reviewPlan && planningActive && <PlanningSteps phase={run.planCheckingAt ? 'checking' : 'drafting'} />}
              <div className="flex shrink-0 items-start gap-3 border-b border-line bg-surface px-4 py-3">
                {planFailure ? (
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                ) : planningActive ? (
                  <Loader2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent motion-reduce:animate-none" />
                ) : null}
                <div className="min-w-0" role="status">
                  <h2 className="text-sm font-semibold text-ink">规划 Agent 输出</h2>
                  <p className="mt-0.5 text-xs leading-5 text-muted">
                    {run.status === 'paused'
                      ? '任务拆解已暂停。点击顶部的继续按钮重新拆解。'
                      : planFailure
                        ? failureText(planFailure)
                        : run.planCheckingAt ? '正在核对需求覆盖、依赖和验收条件。' : '正在生成任务图。Agent 输出会实时出现在下方。'}
                  </p>
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <EventStream events={run.events} onSelectNode={selectNode} />
              </div>
            </div>
          ) : activeView === 'graph' ? (
            <WorkflowCanvas key={run.id} run={run} onInspectNode={selectNode} />
          ) : activeView === 'plan' ? (
            <RunPlanPanel run={run} live={source === 'live'} onSelectNode={selectNode} />
          ) : activeView === 'board' ? (
            <RunBoard
              run={run}
              selectedNodeId={selectedNodeId}
              onSelectNode={selectNode}
            />
          ) : (
            <EventStream
              events={run.events}
              onSelectNode={selectNode}
            />
          )}
        </div>

        <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden border-l border-line bg-surface max-[1100px]:h-[520px] max-[1100px]:w-full max-[1100px]:border-l-0 max-[1100px]:border-t">
          {/*
            「和编排器对话」是这一列里最先被看到的东西：说一句、看图上变了什么，
            是这个页面最主要的工作节奏。做成常驻按钮而不是切换页签，是因为切换
            会把概览挤走——而现在两件事可以在同一个屏幕上并存。
          */}
          <div className="shrink-0 border-b border-line p-2.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOrchestratorOpen(true)}
              aria-haspopup="dialog"
              className="w-full justify-start gap-2 border-accent/25 bg-accent-soft/40 text-accent hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
            >
              <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
              和编排器对话
              <span className="ml-auto rounded-full bg-surface px-1.5 text-[10px] tabular-nums text-muted">
                {run.conversation.length}
              </span>
            </Button>
          </div>

          <RunBlackboard key={run.id} runId={run.id} />
          <NodeInspector
            run={run}
            node={selectedNode}
            onSelectNode={selectNode}
            className="min-h-0 flex-1"
          />
        </aside>
      </div>

      {/* 挂在页面根节点之下、由 createPortal 送进 body：
          父级的 overflow-hidden 与 340px 列宽都不会裁剪它 */}
      <OrchestratorPanel
        run={run}
        open={orchestratorOpen}
        onClose={() => setOrchestratorOpen(false)}
        // 消息落库后重读：会话、图与节点状态全部由后端派生
        onRunChanged={reload}
      />

      <NodeDetailPanel
        run={run}
        node={detailNode}
        onClose={closeDetail}
        onSelectNode={selectNode}
        onRunChanged={reload}
      />
    </div>
  );
}
