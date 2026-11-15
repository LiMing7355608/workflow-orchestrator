import { useMemo } from 'react';
import { deriveBoard } from '../../lib/board';
import { cn } from '../../lib/cn';
import type { WorkflowRunDetail } from '../../types/workflow';
import { BoardCard } from './BoardCard';

interface RunBoardProps {
  run: WorkflowRunDetail;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}

export function RunBoard({
  run,
  selectedNodeId,
  onSelectNode,
}: RunBoardProps) {
  const columns = useMemo(() => deriveBoard(run), [run]);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid min-w-[860px] grid-cols-4 gap-3">
        {columns.map((column) => (
          <section
            key={column.key}
            className="flex min-h-[420px] flex-col rounded-xl border border-line bg-subtle/30"
          >
            <div className="border-b border-line px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className={cn('h-1.5 w-1.5 rounded-full', column.dot)}
                />
                <h2 className="text-[11px] font-medium text-ink">
                  {column.title}
                </h2>
                <span className="ml-auto text-[10px] tabular-nums text-passive">
                  {column.cards.length}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-passive">
                {column.description}
              </p>
            </div>

            <div className="flex-1 space-y-2 p-2">
              {column.cards.length > 0 ? (
                column.cards.map((card) => {
                  const chainIds = [
                    card.implement.id,
                    card.review?.id,
                    card.approval?.id,
                  ].filter((id): id is string => Boolean(id));

                  return (
                    <BoardCard
                      key={card.id}
                      card={card}
                      selected={
                        selectedNodeId
                          ? chainIds.includes(selectedNodeId)
                          : false
                      }
                      onSelect={onSelectNode}
                    />
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[10px] text-passive">
                  暂无任务
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
