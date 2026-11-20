import { useEffect } from 'react';
import {
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { AgentsPage } from '../pages/AgentsPage';
import { HomePage } from '../pages/HomePage';
import { MeetingsPage } from '../pages/MeetingsPage';
import { NewRunPage } from '../pages/NewRunPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { RunDetailPage } from '../pages/RunDetailPage';
import { RunRecordsPage } from '../pages/RunRecordsPage';

function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (!hash) {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [pathname, hash]);

  return null;
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="new" element={<NewRunPage />} />
          <Route path="runs" element={<RunRecordsPage />} />
          <Route path="runs/:runId" element={<RunDetailPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="meetings/:meetingId?" element={<MeetingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </>
  );
}
