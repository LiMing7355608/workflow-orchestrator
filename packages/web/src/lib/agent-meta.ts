import type { BadgeTone } from '../components/ui/Badge';
import type {
  AgentAvailability,
  AgentCapabilities,
  AgentParserId,
  PermissionPolicy,
  SessionDerive,
} from '../types/agent';

export interface AvailabilityMeta {
  label: string;
  description: string;
  tone: BadgeTone;
}

export const availabilityMeta: Record<AgentAvailability, AvailabilityMeta> = {
  ready: {
    label: '可直接调用',
    description: '已安装，参数在本机实测跑通',
    tone: 'green',
  },
  installed: {
    label: '仅安装',
    description: '已安装，但参数按官方文档编写、尚未实测',
    tone: 'amber',
  },
  missing: {
    label: '未安装',
    description: '本机找不到可执行文件，加入流程后会在此步失败并给出原因',
    tone: 'neutral',
  },
};

export type CapabilityKey = keyof AgentCapabilities;

export const capabilityMeta: Record<
  CapabilityKey,
  { label: string; description: string }
> = {
  streaming: { label: '流式', description: '实时输出执行增量' },
  structured: {
    label: '结构化',
    description: '保证结构化结果，可被下游节点直接消费',
  },
  resume: { label: '续跑', description: '可按会话 id 继续上一次上下文' },
  tools: { label: '工具', description: '可读写文件、调用外部工具' },
};

export const capabilityOrder: CapabilityKey[] = [
  'streaming',
  'structured',
  'resume',
  'tools',
];

export const permissionOrder: PermissionPolicy[] = [
  'default',
  'accept-edits',
  'auto',
  'bypass-permissions',
];

export const permissionMeta: Record<
  PermissionPolicy,
  { label: string; short: string; description: string; tone: BadgeTone }
> = {
  default: {
    label: '只读',
    short: '只读',
    description: '不追加任何提权参数，审查节点固定使用这一档',
    tone: 'neutral',
  },
  'accept-edits': {
    label: '可改文件',
    short: '改文件',
    description: '允许写盘，但敏感操作仍需确认',
    tone: 'blue',
  },
  auto: {
    label: '自动放行',
    short: '自动',
    description: '常规操作自动应答，不再逐条打断',
    tone: 'amber',
  },
  'bypass-permissions': {
    label: '完全放行',
    short: '放行',
    description: '跳过全部审批与沙箱，仅用于可信节点',
    tone: 'coral',
  },
};

export const sessionDeriveMeta: Record<
  SessionDerive,
  { label: string; description: string }
> = {
  uuidv5: {
    label: '确定性派生',
    description: '由编排器 session id 派生，重启后能重算同一个原生 id',
  },
  hooked: {
    label: '钩子捕获',
    description: '依赖平台 hook 或流式输出捕获，拿不到时续跑降级为新跑',
  },
  none: { label: '不支持续跑', description: '该平台没有可复用的会话标识' },
};

export const parserLabels: Record<AgentParserId, string> = {
  'claude-stream-json': 'Claude 流式 JSON',
  'codex-json': 'Codex 事件流',
  'opencode-json': 'OpenCode NDJSON',
  'dsh-json': 'DSH JSON 流',
  'json-result': '单次 JSON 结果',
  plain: '纯文本',
};
