import {
  buildAgentArgv,
  type AgentProfile,
  type AgentRunner,
  type WorkspacePort,
} from '@orchestrator/core';
import { safeParseDag, type Dag } from './schema.js';
import { validateDag, type DagIssue } from './validate.js';

/**
 * 自然语言目标 → DAG。
 *
 * Planner 不是另开一条 API 通道，而是和实现、审查节点一样走 `AgentRunner`：
 * 用目录里已经装好的 CLI Agent 干活。这样凭据由 Agent 自己管，用户装了哪个
 * 就能用哪个，不需要在编排器里再维护一份模型凭据。
 *
 * 这里只负责「让 Agent 产出一张能冻结的图」，不落事件、不派发。契约上与
 * 客户端手写 DAG 走同一条闸门（schema + validateDag），区别是不通过时我们有
 * 资格把问题回灌给 Agent 让它重写，而不是直接拒单。
 */

/** prompt 里带这个标记，回放执行器据此返回确定性 DAG。 */
export const PLANNER_PROMPT_MARKER = 'PLANNER_OUTPUT_JSON';

/** 规划阶段不写仓库，所以权限只用最保守的一档。 */
const PLANNER_POLICY = 'default' as const;

const DEFAULT_MAX_ATTEMPTS = 3;

export interface PlannerExecution {
  runner: AgentRunner;
  workspace: WorkspacePort;
  /** 回传 Agent 的增量输出，便于上层记事件或打到日志 */
  onOutput?: (chunk: string) => void;
}

export interface PlannerOptions {
  /** 指定用哪个 Agent 规划；留空则按能力与可用性自动挑 */
  agentId?: string;
  /** Agent 产出不合格时最多重来几次 */
  maxAttempts?: number;
}

export interface GeneratedPlan {
  dag: Dag;
  /** 实际调用 Agent 的次数 */
  attempts: number;
  /**
   * 过程中累计出现过的校验问题（已去重）。
   * 成功时也可能非空：它记录的是 Agent 前几轮踩过的坑，是排障线索而非错误。
   */
  issues: DagIssue[];
  agentId: string;
  agentLabel: string;
}

/**
 * 生成失败。单独成型是为了让上层区分「Agent 给的图不合格」（带 issues，
 * 能展示给人看）和「Agent 压根跑不起来」（没有 issues，讲了也没用）。
 */
export class DagGenerationError extends Error {
  readonly attempts: number;
  readonly issues: DagIssue[];

  constructor(
    message: string,
    attempts: number,
    issues: DagIssue[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DagGenerationError';
    this.attempts = attempts;
    this.issues = issues;
  }
}

/** 打分只为了让「能给出结构化输出、而且本机真的跑得通」的 Agent 排前面。 */
function scoreAgent(agent: AgentProfile): number {
  let score = 0;
  if (agent.availability === 'ready') {
    score += 4;
  } else if (agent.availability === 'installed') {
    score += 2;
  }
  if (agent.capabilities.structured) {
    score += 2;
  }
  if (agent.capabilities.tools) {
    score += 1;
  }
  return score;
}

/** 可参与规划的 Agent：已启用且本机不是 missing。 */
export function usablePlannerAgents(catalog: AgentProfile[]): AgentProfile[] {
  return catalog
    .filter((agent) => agent.enabled && agent.availability !== 'missing')
    .sort((left, right) => scoreAgent(right) - scoreAgent(left));
}

export function pickPlannerAgent(
  catalog: AgentProfile[],
  agentId?: string,
): AgentProfile | undefined {
  if (agentId) {
    // 显式指定就不做二次筛选，让上层拿到明确原因而不是被悄悄换掉
    return catalog.find((agent) => agent.id === agentId);
  }
  return usablePlannerAgents(catalog)[0];
}

function capabilityTags(agent: AgentProfile): string {
  const tags: string[] = [];
  if (agent.capabilities.structured) tags.push('结构化输出');
  if (agent.capabilities.streaming) tags.push('流式');
  if (agent.capabilities.tools) tags.push('工具');
  return tags.length > 0 ? tags.join('、') : '基础';
}

function buildPlannerPrompt(
  goal: string,
  catalog: AgentProfile[],
  previousIssues: DagIssue[],
): string {
  const usable = usablePlannerAgents(catalog);
  const roster = usable
    .map((agent) => `- ${agent.id}（${agent.label} · ${capabilityTags(agent)}）`)
    .join('\n');

  const lines = [
    '# 任务：把目标拆成可执行的任务图',
    '',
    // 单行目标，方便执行器与回放器精确识别，不必在整段 prompt 里猜
    `GOAL: ${goal.trim().replace(/\s+/g, ' ')}`,
    '',
    '## 目标原文',
    goal.trim(),
    '',
    '## 可用的执行 Agent',
    roster || '（没有可用的 Agent）',
    '',
    `可用 agentId 白名单：${usable.map((agent) => agent.id).join(', ') || '无'}`,
    '',
    '## 输出要求',
    '只输出一个 JSON 对象，不要解释，也不要在 JSON 之外写任何文字。',
    '结构示例：',
    '{',
    '  "title": "短标题",',
    '  "summary": "一句话说明这张图做什么",',
    '  "specVersion": "v1.0",',
    '  "nodes": [',
    '    {',
    '      "id": "impl-core",',
    '      "type": "implement",',
    '      "title": "实现核心流程",',
    '      "description": "要做什么、验收标准是什么",',
    '      "dependsOn": [],',
    '      "files": ["src/core/**"],',
    '      "agentId": "claude",',
    '      "maxAttempts": 3',
    '    }',
    '  ]',
    '}',
    '',
    '## 硬性约束',
    '- 节点 id 只能用小写字母、数字与连字符，且全图唯一',
    '- type 只能是 implement / review / approval / route',
    '- implement 与 review 必须填 agentId，且只能取上面白名单里的值',
    '- approval 填 executor（人类角色名），不要填 agentId',
    '- route 两者都不填，它是编排器的纯逻辑节点',
    '- 无依赖关系的并行 implement 节点，files 不得相交',
    '- 图不允许有环',
    '- 让审查节点使用与实现节点不同的 Agent，以获得异构视角',
    `- 输出前自查一遍上述约束。标记：${PLANNER_PROMPT_MARKER}`,
  ];

  if (previousIssues.length > 0) {
    lines.push(
      '',
      '## 上一版被拒绝的原因，这次必须改掉',
      ...previousIssues.map((issue) => `- ${issue.message}`),
    );
  }

  return lines.join('\n');
}

/** 从整段输出里找第一个配平的 JSON 对象。 */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced?.[1] ? [fenced[1], text] : [text];

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start === -1) {
      continue;
    }
    const slice = sliceBalancedObject(candidate.slice(start));
    if (!slice) {
      continue;
    }
    try {
      return JSON.parse(slice);
    } catch {
      // 换下一个候选
    }
  }
  return undefined;
}

/** 按括号配平截取，字符串里的括号不算。 */
function sliceBalancedObject(text: string): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(0, index + 1);
      }
    }
  }
  return undefined;
}

function issueKey(issue: DagIssue): string {
  return `${issue.kind}:${[...issue.nodeIds].sort().join(',')}`;
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * 用 Agent 生成并校验一张 DAG。
 *
 * 不合格就把校验问题原样回灌给同一个 Agent 重写——这是它区别于「一次性生成」
 * 的地方：闸门不是为了拒单，而是为了给出可执行的修改指令。
 */
export async function generateDag(
  goal: string,
  catalog: AgentProfile[],
  execution: PlannerExecution,
  options: PlannerOptions = {},
): Promise<GeneratedPlan> {
  const agent = pickPlannerAgent(catalog, options.agentId);
  if (!agent) {
    throw new DagGenerationError(
      options.agentId
        ? `指定的 Agent 不在目录里：${options.agentId}`
        : '目录里没有可用的 Agent，先装一个 CLI Agent 或在 Agent 管理页启用',
      0,
      [],
    );
  }
  if (!agent.enabled) {
    throw new DagGenerationError(`Agent ${agent.label} 未启用`, 0, []);
  }
  if (agent.availability === 'missing') {
    throw new DagGenerationError(`Agent ${agent.label} 在本机未安装`, 0, []);
  }

  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const issues: DagIssue[] = [];
  const seen = new Set<string>();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = buildPlannerPrompt(goal, catalog, issues);
    const nodeId = `plan-${attempt}`;

    let cwd: string;
    try {
      cwd = await execution.workspace.prepare('planner', nodeId);
    } catch (error) {
      throw new DagGenerationError(
        `规划工作区准备失败：${(error as Error).message}`,
        attempt,
        issues,
        { cause: error },
      );
    }

    const argv = buildAgentArgv(agent, {
      prompt,
      workdir: cwd,
      policy: PLANNER_POLICY,
    });

    const result = await execution.runner.run(
      {
        runId: 'planner',
        nodeId,
        agentId: agent.id,
        bin: agent.launch.bin,
        argv,
        // Agent 从 stdin 读提示词时才有这一项，否则走 argv 里的位置参数
        stdin: agent.launch.stdin ? prompt : undefined,
        cwd,
        timeoutMs: agent.timeoutMs,
        policy: PLANNER_POLICY,
      },
      (chunk) => execution.onOutput?.(chunk),
    );

    await execution.workspace.release('planner', nodeId).catch(() => {});

    if (!result.ok) {
      if (attempt === maxAttempts) {
        throw new DagGenerationError(
          result.timedOut
            ? `规划 Agent 超时（${Math.round(agent.timeoutMs / 1000)} 秒）`
            : `规划 Agent 执行失败：${result.error ?? `退出码 ${result.exitCode ?? '未知'}`}`,
          attempt,
          issues,
        );
      }
      continue;
    }

    const parsed = safeParseDag(extractJsonObject(result.output));
    if (!parsed.success) {
      if (attempt === maxAttempts) {
        throw new DagGenerationError(
          `Agent 没有给出合法的 DAG JSON：${truncate(result.output, 400)}`,
          attempt,
          issues,
        );
      }
      continue;
    }

    const validation = validateDag(parsed.data, catalog);
    if (!validation.ok) {
      for (const issue of validation.issues) {
        const key = issueKey(issue);
        if (!seen.has(key)) {
          seen.add(key);
          issues.push(issue);
        }
      }
      if (attempt === maxAttempts) {
        break;
      }
      continue;
    }

    return {
      dag: parsed.data,
      attempts: attempt,
      issues,
      agentId: agent.id,
      agentLabel: agent.label,
    };
  }

  throw new DagGenerationError(
    `Agent 连续 ${maxAttempts} 次给出的 DAG 都没通过校验`,
    maxAttempts,
    issues,
  );
}
