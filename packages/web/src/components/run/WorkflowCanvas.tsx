import {
  Background, BackgroundVariant, BaseEdge, MarkerType, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  getSmoothStepPath, useReactFlow, useViewport, type Edge, type EdgeProps, type EdgeTypes, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Activity, ChevronRight, Expand, Focus, Maximize2, Minus, Plus, Shrink, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { layoutDag } from '../../lib/dag-layout';
import { formatClock, formatDateTime } from '../../lib/format';
import { displayNodeStatus, nodeStatusMeta } from '../../lib/workflow-meta';
import type { WorkflowRunDetail } from '../../types/workflow';
import { Button } from '../ui/Button';
import { NodeTimes } from './TaskBreakdown';
import {
  COMPACT_HEIGHT, COMPACT_WIDTH, EXPANDED_HEIGHT, NODE_HEIGHT, NODE_WIDTH, WorkflowNodeCard, type WorkflowFlowNode,
} from './WorkflowNodeCard';

const nodeTypes = { workflow: WorkflowNodeCard } satisfies NodeTypes;
type DependencyState = 'running' | 'passed' | 'waiting' | 'failed' | 'pending';
type DependencyEdge = Edge<{ state: DependencyState; related: boolean; dim: boolean }, 'dependency'>;

function WorkflowDependency({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, data, markerEnd }: EdgeProps<DependencyEdge>) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 14 });
  return <g className="workflow-dependency" data-state={data?.state} data-related={data?.related} data-dim={data?.dim}>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} className="workflow-dependency-base" />
    {data?.state === 'running' && <path aria-hidden="true" className="workflow-dependency-pulse" pathLength={100} d={path} />}
  </g>;
}

const edgeTypes = { dependency: WorkflowDependency } satisfies EdgeTypes;
const fitted = { padding: 0.18, maxZoom: 1.1 };

interface WorkflowCanvasProps {
  run: WorkflowRunDetail;
  onInspectNode: (nodeId: string) => void;
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return <ReactFlowProvider><Graph {...props} /></ReactFlowProvider>;
}

function Graph({ run, onInspectNode }: WorkflowCanvasProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [compact, setCompact] = useState(run.nodes.length > 18);
  const [fullscreen, setFullscreen] = useState(false);
  const [onlyRelated, setOnlyRelated] = useState(false);
  const { fitView, zoomIn, zoomOut, setCenter, getNode, getZoom } = useReactFlow<WorkflowFlowNode, DependencyEdge>();
  const { zoom } = useViewport();
  useEffect(() => {
    if (!fullscreen) return;
    const exit = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', exit);
    return () => window.removeEventListener('keydown', exit);
  }, [fullscreen]);


  const current = run.nodes.find((node) => node.id === selected);
  const running = run.nodes.filter((node) => node.status === 'running');
  const waiting = run.nodes.filter((node) => node.status === 'waiting_approval');
  const active = running[0] ?? waiting[0];
  const completed = run.nodes.filter((node) => node.status === 'completed').length;
  const byId = useMemo(() => new Map(run.nodes.map((node) => [node.id, node])), [run.nodes]);
  const shownIds = useMemo(() => {
    if (!onlyRelated || !current) return undefined;
    const ids = new Set([current.id]);
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    for (const { source, target } of run.edges) {
      incoming.set(target, [...(incoming.get(target) ?? []), source]);
      outgoing.set(source, [...(outgoing.get(source) ?? []), target]);
    }
    for (const group of [incoming, outgoing]) {
      const seen = new Set<string>([current.id]);
      const queue = [current.id];
      for (let index = 0; index < queue.length; index += 1) {
        for (const id of group.get(queue[index]!) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          ids.add(id);
          queue.push(id);
        }
      }
    }
    return ids;
  }, [current, onlyRelated, run.edges]);

  const nodes = shownIds ? run.nodes.filter((node) => shownIds.has(node.id)) : run.nodes;
  const edges = shownIds ? run.edges.filter((edge) => shownIds.has(edge.source) && shownIds.has(edge.target)) : run.edges;
  const compactHeight = compact ? COMPACT_HEIGHT : NODE_HEIGHT;
  const width = compact ? COMPACT_WIDTH : NODE_WIDTH;
  const toggle = useCallback((id: string) => {
    setSelected(id);
    setExpanded((previous) => previous === id ? null : id);
  }, []);
  const fit = useCallback(() => {
    requestAnimationFrame(() => void fitView({ ...fitted, duration: 170 }));
  }, [fitView]);

  function locate(id: string) {
    const node = getNode(id);
    if (!node) return;
    setSelected(id);
    const { x, y } = node.position;
    const centerX = x + (node.measured?.width ?? width) / 2;
    const centerY = y + (node.measured?.height ?? compactHeight) / 2 + 22;
    void setCenter(centerX, centerY, { zoom: Math.min(1.2, Math.max(getZoom(), 0.72)), duration: 200 });
  }

  const flowNodes = useMemo<WorkflowFlowNode[]>(() => {
    const positions = layoutDag(nodes, edges, {
      nodeWidth: width, nodeHeight: compactHeight, horizontalGap: 34, verticalGap: 41,
      heightByNode: expanded ? new Map([[expanded, EXPANDED_HEIGHT]]) : undefined,
    });
    return nodes.map((node) => ({
      id: node.id, type: 'workflow', position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node, compact, expanded: expanded === node.id, onToggle: () => toggle(node.id), onInspect: () => onInspectNode(node.id) },
      selected: node.id === selected,
      draggable: false,
      ariaLabel: node.title + ' · ' + nodeStatusMeta[displayNodeStatus(node)].label,
    }));
  }, [nodes, edges, width, compactHeight, expanded, compact, selected, toggle, onInspectNode]);

  const flowEdges = useMemo<DependencyEdge[]>(() => edges.map((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const related = Boolean(selected && (edge.source === selected || edge.target === selected));
    const state: DependencyState = target?.status === 'failed' && source?.status === 'completed' ? 'failed'
      : source?.status === 'completed' && target?.status === 'running' ? 'running'
      : source?.status === 'completed' && target?.status === 'waiting_approval' ? 'waiting'
      : source?.status === 'completed' && target?.status === 'completed' ? 'passed'
      : 'pending';
    const colors = { pending: '#adb6c3', running: '#2563eb', waiting: '#b26b14', failed: '#ba4750', passed: '#599079' };
    return {
      ...edge, type: 'dependency', data: { state, related, dim: Boolean(selected && !related && state !== 'running' && !onlyRelated) },
      markerEnd: { type: MarkerType.ArrowClosed, color: colors[state], width: 15, height: 15 },
      selectable: false,
    };
  }), [edges, byId, selected, onlyRelated]);

  return <section className={cn('workflow-canvas relative flex h-full min-h-0 w-full flex-col overflow-hidden', fullscreen && 'fixed inset-0 z-40 !h-screen')}
    data-detail={zoom < 0.5 ? 'minimal' : 'normal'} aria-label="编排图">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 shrink-0 border-b border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-ink">
        <Activity className={cn('size-4', active ? 'text-accent' : 'text-muted')} aria-hidden="true" />
        {running.length ? running.length + ' 个执行中' : waiting.length ? waiting.length + ' 个待审批' : completed === run.nodes.length ? '已完成' : '运行状态'}
      </div>
      <span className="text-[11px] tabular-nums text-muted">{completed} / {run.nodes.length} 个已完成</span>
      {run.updatedAt && <time dateTime={run.updatedAt} title={formatDateTime(run.updatedAt)} className="font-mono text-[10px] tabular-nums text-muted">更新 {formatClock(run.updatedAt)}</time>}
      {active && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-accent" onClick={() => { if (shownIds && !shownIds.has(active.id)) { setOnlyRelated(false); setSelected(active.id); fit(); } else locate(active.id); }}>
        <Focus className="size-3.5" />定位{running.length ? '运行中' : '待审批'}节点
      </Button>}
    </div>
    <div className="relative min-h-0 min-w-0 flex-1">
      <ReactFlow<WorkflowFlowNode, DependencyEdge>
        nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodeClick={(_, node) => toggle(node.id)}
        onNodeDoubleClick={(_, node) => onInspectNode(node.id)}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea')) return;
          if (event.key === 'Enter' && selected) toggle(selected);
        }}
        onPaneClick={() => { setSelected(null); setExpanded(null); setOnlyRelated(false); }}
        fitView fitViewOptions={fitted} minZoom={0.12} maxZoom={1.7}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={run.nodes.length > 80}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#ced9e5" />
        {run.nodes.length > 12 && !current && <MiniMap<WorkflowFlowNode> position="bottom-right" pannable zoomable
          nodeColor={(node) => nodeStatusMeta[displayNodeStatus(node.data.node)].color}
          className="workflow-minimap !m-3 !h-[96px] !w-[140px] overflow-hidden rounded-lg border border-line !bg-surface/90" />}
        {current && <Panel position="bottom-right" className="workflow-selected-overlay !m-3 max-w-[37%]">
          <div className="min-w-0 rounded-xl border border-line bg-surface/95 px-3 py-2 shadow-sm">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <span className="min-w-0 flex-1 truncate" title={current.title}>{current.title}</span>
              <Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label="清除节点选择" onClick={() => { setSelected(null); setExpanded(null); setOnlyRelated(false); }}><X className="size-3.5" /></Button>
            </p>
            <NodeTimes node={current} />
            <div className="mt-1.5 flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" aria-pressed={onlyRelated} onClick={() => { setOnlyRelated(!onlyRelated); fit(); }}>{onlyRelated ? '完整图' : '聚焦依赖链'}</Button>
              <Button size="sm" variant="secondary" onClick={() => onInspectNode(current.id)}>节点详情<ChevronRight className="size-3" /></Button>
            </div>
          </div>
        </Panel>}
      </ReactFlow>
    </div>
    <div className="flex flex-wrap items-center gap-1 shrink-0 border-t border-line bg-surface px-2 py-1">
      <Button size="icon" variant="ghost" aria-label="缩小编排图" title="缩小" onClick={() => void zoomOut({ duration: 120 })}><Minus className="size-4" /></Button>
      <span className="w-10 text-center font-mono text-[11px] tabular-nums text-muted" aria-label="画布缩放比例">{Math.round(zoom * 100)}%</span>
      <Button size="icon" variant="ghost" aria-label="放大编排图" title="放大" onClick={() => void zoomIn({ duration: 120 })}><Plus className="size-4" /></Button>
      <Button size="icon" variant="ghost" aria-label="适应画布" title="适应画布" onClick={fit}><Expand className="size-4" /></Button>
      <Button size="sm" variant="ghost" aria-pressed={compact} onClick={() => { setCompact(!compact); fit(); }}>{compact ? '标准卡片' : '紧凑卡片'}</Button>
      <Button size="icon" variant="ghost" aria-label={fullscreen ? '退出全屏编排图' : '全屏编排图'} title={fullscreen ? '退出全屏' : '全屏查看'} onClick={() => { setFullscreen(!fullscreen); fit(); }}>
        {fullscreen ? <Shrink className="size-4" /> : <Maximize2 className="size-4" />}
      </Button>
    </div>
  </section>;
}
