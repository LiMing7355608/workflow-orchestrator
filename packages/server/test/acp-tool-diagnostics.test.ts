import { expect, it } from 'vitest';
import { translateUpdate } from '../src/runners/acp.js';

it('从 DeepSeek 的通用工具事件识别终端，并显示 ACP 提供的 Windows 错误', () => {
  expect(translateUpdate({
    sessionUpdate: 'tool_call', title: 'Tool call', toolCallId: 'call-test',
    status: 'pending', kind: 'other', rawInput: { description: 'command=Get-ChildItem' },
  })[0]?.toolName).toBe('执行命令');
  expect(translateUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'call-test', status: 'failed',
    rawOutput: { message: 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\\example)' },
  }, { name: '执行命令' })).toEqual([
    { kind: 'error', text: '执行命令失败 · Windows 沙箱无法设置工作树访问权限（Win32 5）。' },
  ]);
});

it('在工具更新只携带 ID 时仍可说明应用拒绝了权限申请', () => {
  expect(translateUpdate({
    sessionUpdate: 'tool_call_update', toolCallId: 'call-test', status: 'failed',
  }, { name: '执行命令', denied: true })).toEqual([
    { kind: 'error', text: '执行命令失败 · 需要额外权限，本次权限申请已拒绝。' },
  ]);
});
