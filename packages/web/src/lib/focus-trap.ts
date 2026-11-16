/**
 * 浮层里的 Tab 焦点环。
 *
 * 抽成独立模块而不是每个浮层各写一份：这段「首尾相接」的数学一旦写错，
 * 键盘用户会从浮层里掉到背后的页面上，而那种破绽在评审时几乎看不出来
 * （鼠标用户永远碰不到它）。NodeDetailPanel 与 OrchestratorPanel 共用这一份。
 */

/** 可聚焦元素选择器：与浏览器的 Tab 顺序一致。 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 把 Tab / Shift+Tab 关在面板内部。
 *
 * 只在 keydown 里被调用，不自己注册监听：谁来收键盘事件、Esc 归谁处理，
 * 仍然由每个面板自己决定。
 */
export function trapTabKey(event: KeyboardEvent, panel: HTMLElement | null): void {
  if (event.key !== 'Tab' || !panel) {
    return;
  }
  const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!first || !last) {
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey) {
    // 首帧焦点可能在容器自己身上（不是第一个可聚焦元素），从那里 Shift+Tab
    // 会直接溜到背后的页面里，所以把容器也当成「第一个之前」
    if (active === first || active === panel || !panel.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last || !panel.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}
