import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function AppShell() {
  return (
    <div className="min-h-screen bg-canvas">
      <Sidebar />
      <div className="pl-[232px] max-[1100px]:pl-[68px]">
        <Topbar />
        <main className="min-h-[calc(100vh-56px)]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
