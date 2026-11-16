import { create } from 'zustand';
import { DEFAULT_ACTOR, getActor, setActor as persistActor } from './identity';

interface IdentityState {
  /** 当前审批人，顶栏显示、审批提交与 X-Actor 头都用它 */
  actor: string;
  /** 改身份：立刻写回 localStorage，刷新后仍是同一个人 */
  setActor: (name: string) => void;
}

/**
 * 身份的全局状态。
 *
 * 用 store 而不是每个组件各自读 localStorage，是因为顶栏与审批卡片必须
 * 显示同一个值——两边各读一次 localStorage 也能工作，但改了名字之后
 * 顶栏不会重渲染。状态在这里收敛，写入同时落盘，两头就不会漂。
 */
export const useIdentity = create<IdentityState>((set) => ({
  actor: getActor(),
  setActor: (name) => {
    const next = name.trim() || DEFAULT_ACTOR;
    persistActor(next);
    set({ actor: next });
  },
}));
