import { GitBranch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EventStream } from '../components/run/EventStream';
import { NodeInspector } from '../components/run/NodeInspector';
import { RunBoard } from '../components/run/RunBoard';
import { RunHeader } from '../components/run/RunHeader';
import { ViewBar, type RunView } from '../components/run/ViewBar';
import { WorkflowCanvas } from '../components/run/WorkflowCanvas';
import { buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { getRunDetail } from '../data/run-detail';
import { fetchRunDetail } from '../lib/api';
import { useApiResource, useLiveRefresh } from '../lib/use-api';
import { usePageTitle } from '../lib/use-page-title';

export function RunDetailPage() {
  const { runId } = useParams();
  const fallback = useMemo(() => getRunDetail(runId ?? '') ?? null, [runId]);
  const {
    data: run,
    source,
    reload,
  } = useApiResource(() => fetchRunDetail(runId ?? ''), fallback);
  useLiveRefresh(source === 'live', reload, { runId });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<RunView>('graph');

  usePageTitle(run?.title ?? '运行详情');

  useEffect(() => {
    setSelectedNodeId(null);
    setActiveView('graph');
  }, [runId]);

  if (!run) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
        <Card>
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
        </Card>
      </div>
    );
  }

  const selectedNode = selectedNodeId
    ? (run.nodes.find((node) => node.id === selectedNodeId) ?? null)
    : null;

  return (
    <div className="flex h-screen flex-col overflow-hidden max-[1100px]:block max-[1100px]:h-auto max-[1100px]:overflow-visible">
      <RunHeader
        run={run}
        className="shrink-0 border-b border-line"
      />

      <ViewBar
        value={activeView}
        onChange={setActiveView}
        nodeCount={run.nodes.length}
        eventCount={run.events.length}
      />

      <div className="flex min-h-0 flex-1 max-[1100px]:block">
        <div className="min-w-0 flex-1 max-[1100px]:h-[560px]">
          {activeView === 'graph' ? (
            <WorkflowCanvas
              run={run}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
            />
          ) : activeView === 'board' ? (
            <RunBoard
              run={run}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
            />
          ) : (
            <EventStream
              events={run.events}
              onSelectNode={setSelectedNodeId}
            />
          )}
        </div>

        <NodeInspector
          run={run}
          node={selectedNode}
          onSelectNode={setSelectedNodeId}
          onApprovalDecided={reload}
          className="w-[320px] shrink-0 border-l border-line max-[1100px]:h-auto max-[1100px]:w-full max-[1100px]:border-l-0 max-[1100px]:border-t"
        />
      </div>
    </div>
  );
}
