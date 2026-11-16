import { create } from 'zustand';

interface DataSourceState {
  /** 是否有任一页面成功拿到后端数据 */
  live: boolean;
  setLive: (live: boolean) => void;
}

/**
 * 数据源状态。用于在顶栏标示当前看到的是真实数据还是演示数据——
 * 后端没起时界面照样能看，但不能让人误以为那是真的。
 */
export const useDataSource = create<DataSourceState>((set) => ({
  live: false,
  setLive: (live) => set({ live }),
}));
