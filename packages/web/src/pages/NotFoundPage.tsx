import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buttonStyles } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { usePageTitle } from '../lib/use-page-title';

export function NotFoundPage() {
  usePageTitle('页面未找到');

  return (
    <div className="mx-auto max-w-[720px] px-6 py-16 max-[900px]:px-4">
      <Card>
        <EmptyState
          icon={Compass}
          title="页面走丢了"
          description="这个地址没有对应的页面，回到工作台继续。"
          action={
            <Link className={buttonStyles({ size: 'sm' })} to="/">
              返回工作台
            </Link>
          }
        />
      </Card>
    </div>
  );
}
