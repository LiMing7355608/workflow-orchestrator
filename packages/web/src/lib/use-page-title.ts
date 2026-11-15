import { useEffect } from 'react';

const APP_NAME = 'Workflow Orchestrator';

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
}
