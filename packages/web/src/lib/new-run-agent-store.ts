import { create } from 'zustand';
import type { AgentPreferenceRole, AgentPreferences } from '../types/operations';
import { fetchAgentPreferences, saveAgentPreference } from './api';

interface AgentSelection {
  values: AgentPreferences;
  error: string;
  load: () => Promise<void>;
  choose: (role: AgentPreferenceRole, agentId: string, model?: string) => void;
}

let written = Promise.resolve();
let revision = 0;

export const useNewRunAgentStore = create<AgentSelection>((set) => ({
  values: {},
  error: '',
  async load() {
    const current = revision;
    try {
      await written;
      const values = await fetchAgentPreferences();
      if (current === revision) set({ values });
    } catch {
      // The form can still use its in-memory selection.
    }
  },
  choose(role, agentId, model) {
    const current = ++revision;
    set(({ values }) => {
      const models = { ...values[role]?.models };
      if (model === '') delete models[agentId];
      else if (model !== undefined) models[agentId] = model;
      return { values: { ...values, [role]: { agentId, models } }, error: '' };
    });
    written = written.then(async () => {
      const values = await saveAgentPreference(role, agentId, model);
      if (current === revision) set({ values, error: '' });
    }).catch(() => {
      if (current === revision) set({ error: '设置未能保存到本机。' });
    });
  },
}));
