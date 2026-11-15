import { ChevronRight, Database } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';

function getPageTitle(pathname: string): string {
  if (pathname === '/') {
    return '工作台';
  }
  if (pathname === '/new') {
    return '新建运行';
  }
  if (pathname.startsWith('/runs/')) {
    return '运行详情';
  }
  return '页面未找到';
}

export function Topbar() {
  const location = useLocation();
  const title = getPageTitle(location.pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-canvas px-6 max-[900px]:px-4">
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        <span className="text-passive">SE Workflow</span>
        <ChevronRight className="h-3.5 w-3.5 text-passive" strokeWidth={1.8} />
        <span className="truncate font-medium text-ink">{title}</span>
      </div>

      <div className="flex items-center gap-3">
        <Badge tone="neutral" className="max-[700px]:hidden">
          <Database className="h-3 w-3" strokeWidth={1.8} />
          演示数据
        </Badge>
        <Avatar label="2" size="sm" />
      </div>
    </header>
  );
}
