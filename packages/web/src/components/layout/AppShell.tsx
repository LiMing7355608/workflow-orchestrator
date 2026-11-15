import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function AppShell() {
  const { pathname } = useLocation();
  const isRunDetail = /^\/runs\/[^/]+\/?$/.test(pathname);

  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar />
      <div className="pl-[232px] max-[1100px]:pl-[68px]">
        {isRunDetail ? null : <Topbar />}
        <main
          className={
            isRunDetail
              ? 'min-h-screen'
              : 'min-h-[calc(100vh-56px)]'
          }
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
