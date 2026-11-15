import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { layoutDag } from '../../lib/dag-layout';
import { nodeTypeMeta } from '../../lib/workflow-meta';
import type { WorkflowRunDetail } from '../../types/workflow';
import {
  WorkflowNodeCard,
  type WorkflowFlowNode,
} from './WorkflowNodeCard';

const nodeTypes = {
  workflow: WorkflowNodeCard,
} satisfies NodeTypes;

interface WorkflowCanvasProps {
  run: WorkflowRunDetail;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}

export function WorkflowCanvas({
  run,
  selectedNodeId,
  onSelectNode,
}: WorkflowCanvasProps) {
  const flowNodes = useMemo<WorkflowFlowNode[]>(() => {
    const positions = layoutDag(run.nodes, run.edges, {
      horizontalGap: 28,
      verticalGap: 36,
    });

    return run.nodes.map((node) => ({
      id: node.id,
      type: 'workflow',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node },
      selected: node.id === selectedNodeId,
      draggable: false,
    }));
  }, [run, selectedNodeId]);

  const flowEdges = useMemo<Edge[]>(() => {
    const byId = new Map(run.nodes.map((node) => [node.id, node] as const));

    return run.edges.map((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      const active =
        source?.status === 'running' || target?.status === 'running';
      const color =
        target?.type === 'approval'
          ? nodeTypeMeta.approval.color
          : active
            ? nodeTypeMeta.implement.color
            : '#d5d2cb';

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        label: edge.label,
        animated: active,
        style: { stroke: color, strokeWidth: active ? 1.75 : 1.25 },
        markerEnd: { type: MarkerType.ArrowClosed, color },
        labelStyle: { fill: '#6b7280', fontSize: 10 },
        labelBgStyle: { fill: '#ffffff' },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
      };
    });
  }, [run]);

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.35}
        maxZoom={1.4}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        className="bg-canvas"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="#dedbd5"
        />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
}
