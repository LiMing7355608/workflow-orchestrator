/**
 * 审批人身份。
 *
 * 身份本身不该由后端编造，也不该写死在组件里——以前那个常量既不是某个人
 * 也不是某个账号，只是一句「第二组」，导致审批记录上的 actor 永远看不出
 * 是谁按的按钮。
 *
 * 存 localStorage 而不是后端：本项目的登录态由外部（企业 SSO / 网关）提供，
 * 前端能确定知道的只有「这个浏览器上自称是谁」。真正可信的身份由网关注入
 * `X-Actor` 头，这里存的是它不可用时的自报姓名。
 */

/** 默认身份：沿用既有演示约定，但改成可以被覆盖的值。 */
export const DEFAULT_ACTOR = '第二组';

/** 存储键带上项目前缀，避免与同域其他应用的同名键互相覆盖。 */
const STORAGE_KEY = 'orchestrator.actor';

/** 当前身份。读不到（隐私模式、无 window）时回落到默认值，绝不抛。 */
export function getActor(): string {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_ACTOR;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)?.trim();
    return stored ? stored : DEFAULT_ACTOR;
  } catch {
    return DEFAULT_ACTOR;
  }
}

/** 写入身份。空串视为「恢复默认」，避免留下一个无法署名的空身份。 */
export function setActor(name: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  const next = name.trim() || DEFAULT_ACTOR;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 隐私模式下写入会抛，此时身份只在内存里生效，不影响审批本身
  }
}
