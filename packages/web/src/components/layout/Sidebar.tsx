import {
  Bot,
  History,
  LayoutDashboard,
  Plus,
  SquarePen,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { Avatar } from '../ui/Avatar';
import { buttonStyles } from '../ui/Button';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { to: '/', label: '工作台', icon: LayoutDashboard },
  { to: '/new', label: '新建运行', icon: SquarePen },
  { to: '/runs', label: '运行记录', icon: History },
  { to: '/agents', label: 'Agent 管理', icon: Bot },
];

export function Sidebar() {
  const location = useLocation();

  function isActive(item: NavItem) {
    if (item.to === '/') {
      return location.pathname === '/';
    }
    return (
      location.pathname === item.to ||
      location.pathname.startsWith(`${item.to}/`)
    );
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-[232px] flex-col border-r border-line bg-shell max-[1100px]:w-[68px]">
      <div className="flex h-14 items-center px-4">
        <Link
          to="/"
          className="flex min-w-0 items-center gap-2.5"
          aria-label="Workflow Orchestrator 工作台"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-white">
            <Workflow className="h-4 w-4" strokeWidth={1.9} />
          </span>
          <span className="min-w-0 max-[1100px]:hidden">
            <span className="block truncate text-[13px] font-semibold tracking-[-0.01em]">
              Workflow Orchestrator
            </span>
            <span className="block truncate text-[10px] text-passive">
              SE Workflow Studio
            </span>
          </span>
        </Link>
      </div>

      <div className="px-3 pb-3">
        <Link
          to="/new"
          className={cn(
            buttonStyles({ className: 'w-full justify-start' }),
            'max-[1100px]:justify-center max-[1100px]:px-0',
          )}
          title="新建运行"
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          <span className="max-[1100px]:hidden">新建运行</span>
        </Link>
      </div>

      <nav className="flex-1 space-y-0.5 px-2" aria-label="主导航">
        {navItems.map((item) => {
          const active = isActive(item);
          const Icon = item.icon;

          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-150 max-[1100px]:justify-center max-[1100px]:px-0',
                active
                  ? 'bg-subtle font-medium text-ink'
                  : 'text-muted hover:bg-subtle/70 hover:text-ink',
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  active
                    ? 'text-accent'
                    : 'text-passive group-hover:text-muted',
                )}
                strokeWidth={1.8}
              />
              <span className="max-[1100px]:hidden">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line p-3">
        <div className="rounded-lg border border-line bg-surface p-2.5 max-[1100px]:border-0 max-[1100px]:bg-transparent max-[1100px]:p-0">
          <div className="flex items-center gap-2.5">
            <Avatar label="2" size="sm" />
            <div className="min-w-0 max-[1100px]:hidden">
              <p className="truncate text-[12px] font-medium">第二组</p>
              <p className="truncate text-[10px] text-passive">
                软件工程 · 课程大作业
              </p>
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 max-[1100px]:hidden">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            <span className="text-[10px] text-muted">当前为演示数据</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
