import { ChevronRight, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { usePageTitle } from '../lib/use-page-title';

export function NewRunPage() {
  usePageTitle('新建运行');

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-7 max-[900px]:px-4">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <Link to="/" className="transition-colors hover:text-ink">
          工作台
        </Link>
        <ChevronRight className="h-3 w-3 text-passive" strokeWidth={1.8} />
        <span>新建运行</span>
      </div>

      <div className="mt-3">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">
          新建运行
        </h1>
        <p className="mt-1.5 text-[13px] text-muted">
          从设计规格开始，交给 PM Agent 拆解并生成任务编排。
        </p>
      </div>

      <Card className="mt-6">
        <EmptyState
          icon={FileText}
          title="设计规格编辑器将在下一步接入"
          description="这里会支持粘贴产品设计规格、设置分解粒度，并查看 PM Agent 的任务分解过程。"
          action={
            <Link
              to="/"
              className={buttonStyles({ variant: 'secondary', size: 'sm' })}
            >
              返回工作台
            </Link>
          }
        />
      </Card>
    </div>
  );
}
