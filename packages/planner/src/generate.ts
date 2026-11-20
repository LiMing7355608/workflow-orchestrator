import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildAgentArgv,
  createParser,
  type AgentEvent,
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

/**
 * 约定交付文件名。
 *
 * 不让调用方去解析 Agent 的自由输出：CLI Agent 的 stdout 是它自己的事件流
 * （session / status / thinking），从中捞 JSON 必须猜格式，模型一换版本就崩。
 * 改成让 Agent 把结果写进工作区里的约定文件，后端只读文件——读了就是读了，
 * 没读就是没交，没有中间态。
 */
export const PLAN_FILENAME = '.orchestrator-plan.json';

/** 规划器在独立工作区中写入任务图。 */
const PLANNER_POLICY = 'accept-edits' as const;

const DEFAULT_MAX_ATTEMPTS = 3;

export interface PlannerExecution {
  runner: AgentRunner;
  workspace: WorkspacePort;
  /** 回传 Agent 的增量输出，便于上层记事件或打到日志 */
  onOutput?: (chunk: string) => void;
  /** 回传平台解析后的输出，与任务图交付共用同一个解析器。 */
  onEvents?: (events: AgentEvent[]) => void;
  onRetry?: (attempt: number, reason: string) => void | Promise<void>;
  workspaceFiles?: () => Promise<string[]>;
}

export interface PlannerOptions {
  runId?: string;
  signal?: AbortSignal;
  /** 指定用哪个 Agent 规划；留空则按能力与可用性自动挑 */
  agentId?: string;
  /** Agent 产出不合格时最多重来几次 */
  maxAttempts?: number;
  requireDeliverables?: boolean;
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
  textOnly = false,
  workspaceFiles: string[] = [],
): string {
  const usable = usablePlannerAgents(catalog);
  const roster = usable
    .map((agent) => `- ${agent.id}（${agent.label} · ${capabilityTags(agent)}）`)
    .join('\n');

  const lines = [
    '# 任务：把目标拆成可执行的任务图',
    '',
    // 单行目标，方便执行器与回放器精确识别，不必在整段 prompt 里猜
    `GOAL: ${textOnly ? goal.trim().replace(/\s+/g, ' ').slice(0, 240) : goal.trim().replace(/\s+/g, ' ')}`,
    '',
    '## 目标原文',
    goal.trim(),
    '',
    '## 可用的执行 Agent',
    roster || '（没有可用的 Agent）',
    '',
    `可用 agentId 白名单：${usable.map((agent) => agent.id).join(', ') || '无'}`,
    '',
    ...(workspaceFiles.length ? ['## 仓库已跟踪文件（节录）', JSON.stringify(workspaceFiles), ''] : []),
    '## 交付方式',
    ...(textOnly ? [
      '只在最终回复提交完整任务图 JSON。编排器负责解析、校验和写入项目。',
      '使用上面给出的目标、文件索引和可用 Agent。直接生成结果，严禁调用 Shell、文件工具、技能或子 Agent。',
    ] : [
      `把最终的任务图 JSON 写入当前工作目录下的 ${PLAN_FILENAME} 文件，用你的写文件工具完成。`,
      '写好文件后可附一句说明。',
    ]),
    '',
    '## 输出要求',
    '任务图是一个 JSON 对象，不要包含解释文字，也不要用 Markdown 代码块包裹。',
    '- 实现节点只可选择具备工程工具的 Agent。HTTP 文本模型可以承担规划或文本审查。',
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
    '      "deliverables": [{"path":"src/core/index.ts","description":"核心流程入口"}],',
    '      "acceptance": ["给定参考输入，运行主流程，输出符合示例"],',
    '      "agentId": "claude",',
    '      "maxAttempts": 3',
    '    }',
    '  ]',
    '}',
    '',
    '## 分解方法',
    textOnly ? '- 根据规格和已提供的路径规划。缺少工程信息时，在对应任务的验收或说明中标出需要核实的入口。'
      : '- 先通读目标、界面流程、限制和验收条件，有既有工程时核实入口与已有模块。',
    '- 按业务主链拆分阶段。先确定共享接口或基础约定，再展开可并行的实施任务，最后串起集成、端到端验证和交付。',
    '- 实现任务的 files 是允许改动的边界，deliverables 是实际要落盘的文件清单。每个交付项给具体相对路径与用途，不使用通配符。若要求删除文件，声明 kind: remove。',
    '- deliverables 仅可添加到 implement 节点。review、approval、route 节点省略 deliverables。',
    '- 实现和审查节点各填 acceptance，写明可以重现的输入、操作与预期结果。审查任务覆盖主路径和与范围相关的失败场景。',
    '- 所有实施任务都应能沿审查、审批或直接依赖关系追溯到最终交付节点。',
    '- 分解粒度按用户设置。同一责任且验收不可分的工作可以合并，审批和关键验证应能在图上定位。',
    '- 写图前逐项核对规格，关注漏项、交叉覆盖、无效并行、缺少验收和未验证的假设。不要为凑数量拆碎简单任务。',
    '',
    '## 硬性约束',
    '- 节点 id 只能用小写字母、数字与连字符，且全图唯一',
    '- type 只能是 implement / review / approval / route',
    '- implement 与 review 必须填 agentId，且只能取上面白名单里的值',
    '- approval 填 executor（人类角色名），不要填 agentId',
    '- route 两者都不填。交付代码的任务图最后加入人工审批节点以及依赖它的 route 节点，并给 route 设置 action: merge',
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

/**
 * 从整段输出里找出第一个「看起来像 DAG」的 JSON 对象。
 *
 * 不能只取第一个 `{`：CLI Agent 的输出本身是事件流（session / status /
 * thinking），第一个配平对象是事件而不是答案。所以逐个扫描配平对象，
 * 只认带 `nodes` 数组的那个——这才是任务图。
 */
export function extractJsonObject(text: string): unknown {
  const candidates = [/(?:```(?:json)?\s*)([\s\S]*?)```/i.exec(text)?.[1], text]
    .filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    let index = 0;
    while (index < candidate.length) {
      const start = candidate.indexOf('{', index);
      if (start === -1) {
        break;
      }
      const slice = sliceBalancedObject(candidate.slice(start));
      if (!slice) {
        break;
      }
      try {
        const value: unknown = JSON.parse(slice);
        if (looksLikeDag(value)) {
          return value;
        }
      } catch {
        // 这个对象不完整或是别的东西，继续往后找
      }
      index = start + slice.length;
    }
  }
  return undefined;
}

/**
 * 读 Agent 写下来的交付文件。没有就是没交，不猜。
 *
 * 导出是为了让 `amend.ts` 用同一份读取逻辑：两条链路交付的是同一个文件，
 * 谁先谁后改一下读取细节，就会一边读得到、一边读不到。
 */
export async function readSubmittedPlan(cwd: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(join(cwd, PLAN_FILENAME), 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return undefined;
  }
}

export function replyPlan(agent: AgentProfile): boolean {
  return agent.transport === 'acp' || agent.transport === 'http-model';
}

export function draftFromReplies(...replies: string[]): unknown {
  for (const reply of replies) {
    const parsed = extractJsonObject(reply);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function looksLikeDag(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
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
  const textOnly = replyPlan(agent);
  const policy = textOnly ? 'default' : PLANNER_POLICY;
  const files = textOnly ? await execution.workspaceFiles?.() ?? [] : [];
  const issues: DagIssue[] = [];
  const seen = new Set<string>();

  // 每次规划用一套独立的工作目录。
  //
  // 之前固定用 planner/plan-N，目录会在多次运行之间复用：上一轮 Agent 写下的
  // 交付文件还留在那里，新一轮若因为模型没写文件（或还没来得及写），
  // readSubmittedPlan 就会把上一次的计划读回来——用户看到「写计算器」
  // 展开成「起草 README」。用一次性目录从根上避免这种事。
  const workspaceRunId = `planner-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = buildPlannerPrompt(goal, catalog, issues, textOnly, files);
    const nodeId = `attempt-${attempt}`;
    options.signal?.throwIfAborted();

    let cwd: string;
    try {
      cwd = await execution.workspace.prepare(workspaceRunId, nodeId);
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
      policy,
    });

    // 必须按平台解析，不能从裸 stdout 里捞 JSON：CLI Agent 的输出本身
    // 就是一串 JSON 事件（session / status / thinking），第一个 `{` 抓到的是
    // 事件而不是答案。只把 text 与 result 类事件拼成正文，再从正文里找 DAG。
    const parser = createParser(agent.launch.parser);
    let answer = '';
    let final = '';
    const collect = (events: AgentEvent[]): void => {
      execution.onEvents?.(events);
      for (const event of events) {
        if (event.kind === 'text') answer += event.text ?? '';
        if (event.kind === 'result' && event.text) final = event.text;
      }
    };

    const result = await execution.runner.run(
      {
        runId: options.runId ?? workspaceRunId,
        nodeId,
        agentId: agent.id,
        bin: agent.launch.bin,
        argv,
        // Agent 从 stdin 读提示词时才有这一项，否则走 argv 里的位置参数
        stdin: agent.launch.stdin ? prompt : undefined,
        cwd,
        timeoutMs: agent.timeoutMs,
        signal: options.signal,
        policy,
      },
      (chunk) => {
        collect(parser.push(chunk));
        execution.onOutput?.(chunk);
      },
    );
    collect(parser.finish());

    const candidate = final || answer.trim() || result.output;
    const fromReply = draftFromReplies(final, answer, result.output);
    const raw = textOnly && fromReply !== undefined ? fromReply
      : await readSubmittedPlan(cwd) ?? fromReply;

    await execution.workspace.release(workspaceRunId, nodeId).catch(() => {});
    options.signal?.throwIfAborted();
    if (result.cancelled) {
      throw new DagGenerationError('规划执行已取消', attempt, issues);
    }

    if (raw === undefined) {
      if (!result.ok) {
        const reason = result.timedOut
          ? `规划 Agent 超时（${Math.round(agent.timeoutMs / 1000)} 秒）`
          : `规划 Agent 执行失败：${result.error ?? `退出码 ${result.exitCode ?? '未知'}`}`;
        if (attempt === maxAttempts) throw new DagGenerationError(reason, attempt, issues);
        await execution.onRetry?.(attempt, truncate(reason, 450));
        continue;
      }
      const reason = textOnly ? 'Agent 未返回完整的任务图 JSON' : 'Agent 未找到可读取的任务图 ' + PLAN_FILENAME;
      if (attempt === maxAttempts) throw new DagGenerationError(reason + '：' + truncate(candidate, 400), attempt, issues);
      await execution.onRetry?.(attempt, reason);
      continue;
    }

    const parsed = safeParseDag(raw);
    if (!parsed.success) {
      // 结构错误也必须回灌：只说「不合格」，Agent 下一轮还是会犯同样的错
      for (const zodIssue of parsed.error.issues.slice(0, 6)) {
        const path = zodIssue.path.join('.') || '(root)';
        const pseudo: DagIssue = {
          kind: 'schema-invalid',
          message: `${path}: ${zodIssue.message}`,
          nodeIds: [],
        };
        const key = issueKey(pseudo);
        if (!seen.has(key)) {
          seen.add(key);
          issues.push(pseudo);
        }
      }
      if (attempt === maxAttempts) {
        throw new DagGenerationError(
          `Agent 给出的图结构不合法：${truncate(JSON.stringify(raw), 300)}`,
          attempt,
          issues,
        );
      }
      const issue = parsed.error.issues[0];
      const detail = issue && (issue.path.join('.') || '根对象') + ' ' + issue.message;
      await execution.onRetry?.(attempt, '任务图格式有误' + (detail ? ' · ' + detail : ''));
      continue;
    }

    const validation = validateDag(parsed.data, catalog, { requireDeliverables: options.requireDeliverables });
    if (!validation.ok) {
      for (const issue of validation.issues) {
        const key = issueKey(issue);
        if (!seen.has(key)) {
          seen.add(key);
          issues.push(issue);
        }
      }
      if (attempt === maxAttempts) break;
      await execution.onRetry?.(attempt, validation.issues.slice(0, 2).map((issue) => issue.message).join('。'));
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
