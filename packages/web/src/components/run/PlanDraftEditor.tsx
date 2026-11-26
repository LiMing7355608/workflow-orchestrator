import { Background, Controls, MarkerType, Position, ReactFlow, useNodesState, type Connection, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Pencil, RotateCcw, Save, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { editPlanDraft } from '../../lib/api';
import { layoutDag } from '../../lib/dag-layout';
import { nodeTypeMeta } from '../../lib/workflow-meta';
import type { PlanDraftView } from '../../types/operations';
import { Button } from '../ui/Button';

type Task = PlanDraftView['dag']['nodes'][number];
type DraftNode = Node<{ label: string }>;

const taskEdges = (tasks: Task[]): Edge[] => tasks.flatMap((task) => task.dependsOn.map((id) => ({
  id: id + ':' + task.id, source: id, target: task.id, markerEnd: { type: MarkerType.ArrowClosed },
})));

function arrange(tasks: Task[]): DraftNode[] {
  const positions = layoutDag(tasks, taskEdges(tasks), { nodeWidth: 176, nodeHeight: 70 });
  return tasks.map((task) => ({
    id: task.id, data: { label: task.title }, position: positions.get(task.id) ?? { x: 0, y: 0 },
    sourcePosition: Position.Bottom, targetPosition: Position.Top, ariaLabel: task.title, className: 'draft-flow-node',
  }));
}

export function PlanDraftEditor({ runId, plan, onCancel, onSaved, onSaving }: {
  runId: string; plan: PlanDraftView; onCancel: () => void; onSaved: () => void; onSaving: (saving: boolean) => void;
}) {
  const [tasks, setTasks] = useState(plan.dag.nodes);
  const initial = useMemo(() => arrange(plan.dag.nodes), [plan.dag.nodes]);
  const [positions, setPositions, onNodesChange] = useNodesState<DraftNode>(initial);
  const [selectedId, setSelectedId] = useState(plan.dag.nodes[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const edges = useMemo(() => taskEdges(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const selected = byId.get(selectedId);
  const nodes = useMemo(() => positions.map((node) => ({
    ...node, data: { label: byId.get(node.id)?.title || '未命名任务' }, selected: node.id === selectedId,
  })), [byId, positions, selectedId]);
  const changes = tasks.flatMap(({ id, title, description, dependsOn }, index) => {
    const original = plan.dag.nodes[index]!;
    const unchanged = dependsOn.length === original.dependsOn.length && dependsOn.every((id, position) => id === original.dependsOn[position]);
    return title === original.title && description === original.description && unchanged
      ? [] : [{ id, title, description, dependsOn }];
  });

  function update(id: string, edit: Partial<Pick<Task, 'title' | 'description' | 'dependsOn'>>) {
    setError('');
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...edit } : task));
  }

  function canLink(source: string, target: string): boolean {
    const task = byId.get(target);
    if (busy || !byId.has(source) || !task || task.dependsOn.includes(source)) return false;
    const seen = new Set<string>();
    const toCheck = [source];
    while (toCheck.length > 0) {
      const id = toCheck.pop()!;
      if (id === target) return false;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const parent of byId.get(id)?.dependsOn ?? []) toCheck.push(parent);
    }
    return true;
  }

  function connect({ source, target }: Connection) {
    if (canLink(source, target)) {
      update(target, { dependsOn: [...byId.get(target)!.dependsOn, source] });
      setSelectedId(target);
    }
  }

  async function save() {
    setError('');
    setBusy(true);
    onSaving(true);
    try {
      await editPlanDraft(runId, plan.revision, changes);
      onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
      onSaving(false);
    }
  }

  return <section aria-label="临时编辑任务图" className="overflow-hidden rounded-xl border border-line bg-surface">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Pencil className="size-3.5 text-accent" />编辑拆解草案</h3>
        <p className="mt-1 text-[11px] text-muted">拖拽卡片可临时整理画布，拖动连接点可修改依赖。</p>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPositions(arrange(tasks))}><RotateCcw className="size-3.5" />自动排布</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>退出编辑</Button>
        <Button size="sm" disabled={busy || !changes.length || changes.some((task) => !task.title.trim())} onClick={() => void save()}>
          <Save className="size-3.5" />{busy ? '正在保存…' : '保存草案'}
        </Button>
      </div>
    </header>
    {error && <p role="alert" className="border-b border-line px-3.5 py-2 text-xs text-danger">{error}</p>}
    <div className="draft-editor-grid">
      <div className="h-[min(50dvh,500px)] min-h-[270px] min-w-0 bg-canvas" aria-label="草案画布">
        <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} fitView minZoom={0.15} maxZoom={1.8}
          onNodeClick={(_event, node) => setSelectedId(node.id)} onConnect={connect}
          isValidConnection={({ source, target }) => canLink(source, target)}
          nodesConnectable={!busy} deleteKeyCode={null} nodesDraggable={!busy} edgesFocusable={false}>
          <Background color="var(--color-line)" gap={18} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selected && <div className="workspace-scroll max-h-[min(50dvh,500px)] space-y-3 border-line p-3.5 text-xs">
        <label className="block">
          <span className="font-medium">编辑节点</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="draft-editor-input">
            {tasks.map((task) => <option key={task.id} value={task.id}>{task.title || task.id}</option>)}
          </select>
        </label>
        <p className="text-muted">{nodeTypeMeta[selected.type].label} · {selected.id}</p>
        <label className="block">
          <span className="font-medium">任务名称</span>
          <input value={selected.title} disabled={busy} onChange={(event) => update(selected.id, { title: event.target.value })} className="draft-editor-input" />
        </label>
        <label className="block">
          <span className="font-medium">任务说明</span>
          <textarea rows={4} value={selected.description} disabled={busy}
            onChange={(event) => update(selected.id, { description: event.target.value })} className="draft-editor-input resize-y" />
        </label>
        <div>
          <p className="font-medium">前置任务</p>
          <ul className="mt-1 space-y-1">
            {selected.dependsOn.map((id) => <li key={id} className="flex items-center gap-1 rounded-md bg-subtle px-2 py-1">
              <span className="min-w-0 flex-1 break-words">{byId.get(id)?.title ?? id}</span>
              <button type="button" aria-label={'移除依赖 ' + (byId.get(id)?.title ?? id)} disabled={busy}
                className="rounded p-1 text-muted hover:bg-surface hover:text-danger"
                onClick={() => update(selected.id, { dependsOn: selected.dependsOn.filter((item) => item !== id) })}><X className="size-3.5" /></button>
            </li>)}
          </ul>
          <select aria-label="添加前置任务" value="" disabled={busy}
            onChange={(event) => connect({ source: event.target.value, target: selected.id, sourceHandle: null, targetHandle: null })}
            className="draft-editor-input">
            <option value="">添加前置任务…</option>
            {tasks.filter((task) => canLink(task.id, selected.id)).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
        </div>
      </div>}
    </div>
  </section>;
}
