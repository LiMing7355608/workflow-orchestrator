import { describe, expect, it } from 'vitest';
import { SESSION_NAMESPACE, createSessionIdDeriver } from '../src/session-id';

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('会话 id 派生（RFC 4122 v5）', () => {
  const derive = createSessionIdDeriver(SESSION_NAMESPACE);

  it('同一对 (runId, nodeId) 永远得到同一个 id', () => {
    // 「重启后还能接上原会话」的全部依据就是这条性质
    const first = derive('run-abc', 'impl-core');
    const second = derive('run-abc', 'impl-core');

    expect(first).toBe(second);
    // 换一个派生器实例也必须一致——派生只依赖输入与命名空间，不依赖内存状态
    expect(createSessionIdDeriver(SESSION_NAMESPACE)('run-abc', 'impl-core')).toBe(first);
  });

  it('不同输入得到不同 id', () => {
    const base = derive('run-abc', 'impl-core');

    expect(derive('run-abc', 'impl-other')).not.toBe(base);
    expect(derive('run-xyz', 'impl-core')).not.toBe(base);
  });

  it('拼接不会让不同的输入对产生同一个 id', () => {
    // runId 里带斜杠时，`a/b` + `c` 与 `a` + `b/c` 必须区分开
    expect(derive('a/b', 'c')).not.toBe(derive('a', 'b/c'));
  });

  it('换命名空间等于换 id 空间', () => {
    const other = createSessionIdDeriver('6ba7b810-9dad-11d1-80b4-00c04fd430c8');

    expect(other('run-abc', 'impl-core')).not.toBe(derive('run-abc', 'impl-core'));
  });

  it('产出合法的 UUID v5：版本位是 5，变体位落在 8/9/a/b', () => {
    const ids = Array.from({ length: 32 }, (_, index) => derive(`run-${index}`, 'node'));

    for (const id of ids) {
      expect(id).toMatch(UUID_V5);
      // 位序校验：第 15 个字符是版本号，第 20 个字符是变体首字符（含分隔符）
      expect(id[14]).toBe('5');
      expect('89ab').toContain(id[19]);
    }
  });

  it('命名空间不是合法 UUID 时立刻抛错', () => {
    // 配置错误必须在构造期暴露，不能拖到第一个节点重跑时才炸
    expect(() => createSessionIdDeriver('not-a-uuid')).toThrow();
  });
});
