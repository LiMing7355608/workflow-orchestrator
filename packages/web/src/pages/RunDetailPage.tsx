import { GitBranch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { NodeInspector } from '../components/run/NodeInspector';
import { RunHeader } from '../components/run/RunHeader';
import { WorkflowCanvas } from '../components/run/WorkflowCanvas';
import { buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { getRunDetail } from '../data/run-detail';
import { usePageTitle } from '../lib/use-page-title';

export function RunDetailPage() {
  const { runId } = useParams();
  const run = useMemo(() => getRunDetail(runId ?? ''), [runId]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  usePageTitle(run?.title ?? '运行详情');

  useEffect(() => {
    setSelectedNodeId(null);
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

      <div className="flex min-h-0 flex-1 max-[1100px]:block">
        <div className="min-w-0 flex-1 max-[1100px]:h-[520px]">
          <WorkflowCanvas
            run={run}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </div>

        <NodeInspector
          run={run}
          node={selectedNode}
          onSelectNode={setSelectedNodeId}
          className="w-[320px] shrink-0 border-l border-line max-[1100px]:h-auto max-[1100px]:w-full max-[1100px]:border-l-0 max-[1100px]:border-t"
        />
      </div>
    </div>
  );
}
