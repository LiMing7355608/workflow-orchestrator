import {
  buildAgentArgv,
  createParser,
  type AgentProfile,
} from '@orchestrator/core';
import {
  DagGenerationError,
  PLAN_FILENAME,
  pickPlannerAgent,
  readSubmittedPlan,
  usablePlannerAgents,
  type PlannerExecution,
  type PlannerOptions,
} from './generate.js';
import { safeParseDag, type Dag, type DagNode } from './schema.js';
import { validateDag, type DagIssue } from './validate.js';

/**
 * 把「用户的一句话」落成对现有任务图的实际修改。
 *
 * 与 `generateDag` 的分工：那条负责从零拆图，这条负责在已经冻结的图上动刀。
 * 两条链路共用同一套交付机制（Agent 把结果写进工作区里的约定文件、后端读文件）
 * 和同一道闸门（schema + validateDag），区别只在 prompt 里给 Agent 的输入：
 * 这里必须给出「当前这张图长什么样」以及「哪些节点已经动不得了」。
 *
 * 参考实现里对应的做法是让 reviewer 用一条命令把结构化结果交回后端
 * （`printf ... | ao review submit --reviews -`）。我们沿用「约定通道交付、
 * 不解析自由输出」这个思路，只是通道从命令换成了工作区里的文件——因为
 * 我们的 Agent 是各家的 CLI，没有统一的可注入子命令。
 */

/** prompt 里带这个标记，回放执行器据此返回确定性的修改后任务图。 */
export const PLANNER_AMEND_MARKER = 'PLANNER_AMEND_JSON';

/**
 * 当前图 JSON 在 prompt 里的锚点。
 *
 * 紧凑摘要给人读，这段 JSON 给「原样修改」一个精确基准——模型和人一样，
 * 照着完整对象改比照着一行摘要重建可靠得多；回放执行器也直接读这一段。
 */
export const CURRENT_DAG_MARKER = 'CURRENT_DAG_JSON';

/**
 * 允许通过对话修改的节点字段。
 *
 * 这份白名单有两处消费者：prompt（告诉 Agent 能改什么）与服务端的改动比对
 * （决定哪些差异算「生效的改动」）。放在一处，是为了它们不会各自漂移——
 * 一旦 prompt 允许改 dependsOn 而服务端不认，用户就会看到「Agent 说改了，
 * 界面没变」这种最难排查的状态。
 *
 * 为什么不含 type 与 dependsOn：改类型等于换节点职责，改依赖等于重画图，
 * 这两件事都要求整张图重新校验甚至重新规划，不该藏在一次对话里。
 */
export const AMENDABLE_FIELDS = [
  'agentId',
  'title',
  'description',
  'files',
  'deliverables',
  'acceptance',
  'maxAttempts',
] as const;

export type AmendableField = (typeof AMENDABLE_FIELDS)[number];

export interface AmendedPlan {
  dag: Dag;
  /** 实际调用 Agent 的次数 */
  attempts: number;
  /** 过程中累计的校验问题（成功时也可能非空，记录前几轮踩过的坑） */
  issues: DagIssue[];
  agentId: string;
  agentLabel: string;
}

/** 改图选项：比规划多一个「哪些节点已经动不得」。 */
export interface AmendOptions extends PlannerOptions {
  /**
   * 已经开始或已经完成的节点 id。
   *
   * 这些节点的事实已经发生，图里再动它们等于篡改历史。必须由调用方从
   * 运行事实里算出来传进来——Planner 只看得到图，看不到执行到哪一步了。
   */
  lockedNodeIds?: string[];
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** 单个节点的紧凑摘要：一行说清它是什么、谁做、依赖谁、占哪些文件。 */
function nodeSummary(node: DagNode, locked: boolean): string {
  return [
    `- ${node.id}`,
    node.type,
    oneLine(node.title),
    `agent=${node.agentId ?? '-'}`,
    `deps=${node.dependsOn.join(',') || '-'}`,
    `files=${node.files.join(',') || '-'}`,
    `maxAttempts=${node.maxAttempts}`,
    locked ? '已锁定' : '可改',
  ].join(' | ');
}

export function buildAmendmentPrompt(
  goal: string,
  currentDag: Dag,
  instruction: string,
  catalog: AgentProfile[],
  options: { lockedNodeIds?: string[]; previousIssues?: DagIssue[] } = {},
): string {
  const locked = new Set(options.lockedNodeIds ?? []);
  const usable = usablePlannerAgents(catalog);
  const roster = usable
    .map((agent) => `- ${agent.id}（${agent.label}）`)
    .join('\n');
  const whitelist = usable.map((agent) => agent.id).join(', ') || '无';
  const previousIssues = options.previousIssues ?? [];

  const lines = [
    '# 任务：按用户的对话指令修改一张已经冻结的任务图',
    '',
    // 与规划 prompt 同一约定：单行，方便执行器与回放器精确识别
    `INSTRUCTION: ${oneLine(instruction)}`,
    '',
    '## 运行目标',
    goal.trim(),
    '',
    '## 用户的指令原文',
    instruction.trim(),
    '',
    `## 当前任务图（原样修改的基准，标记：${CURRENT_DAG_MARKER}）`,
    '```json',
    JSON.stringify(currentDag, null, 2),
    '```',
    '',
    '## 当前任务图摘要',
    ...currentDag.nodes.map((node) => nodeSummary(node, locked.has(node.id))),
    '',
    '## 已锁定的节点（已经开始或已经完成，绝不能出现在你的改动里）',
    locked.size > 0
      ? [...locked].map((id) => `- ${id}`).join('\n')
      : '（没有已锁定的节点）',
    '',
    '## 可用的执行 Agent',
    roster || '（没有可用的 Agent）',
    '',
    `可用 agentId 白名单：${whitelist}`,
  ];

  if (instruction.length > 4000) {
    lines.push(
      '',
      '> 指令偏长。以「指令原文」为准，但不要因此重写整张图：',
      '> 只改与指令直接相关的节点。',
    );
  }

  lines.push(
    '',
    '## 允许的改动（白名单，超出范围的改动会被后端丢弃）',
    `- 修改尚未开始节点的这些字段：${AMENDABLE_FIELDS.join(' / ')}`,
    '- 新增节点：type 只能是 implement 或 review，必须填白名单里的 agentId',
    '- 删除尚未开始的节点：不得删掉任何已锁定节点所依赖的节点',
    '- 不得修改任何节点的 type 与 dependsOn（新节点可以自己声明 dependsOn）',
    '',
    '## 交付方式（这是硬要求）',
    `把修改后的**完整**任务图写入当前工作目录下的 ${PLAN_FILENAME} 文件。`,
    '是完整的图，不是补丁或差异片段：编排器会用它整体替换当前图。',
    '这是唯一的交付渠道。只在回复里贴 JSON 不算交付，编排器读不到就等于你没做。',
    '',
    '## 输出要求',
    '文件内容是一个 JSON 对象，不要包含解释文字，也不要用 Markdown 代码块包裹。',
    '结构：{ "title": ..., "summary": ..., "specVersion": ..., "nodes": [ ... ] }，',
    '每个节点形如 { "id", "type", "title", "description", "dependsOn", "files", "agentId", "maxAttempts" }。',
    '',
    '## 硬性约束',
    '- 节点 id 只能用小写字母、数字与连字符，且全图唯一',
    '- 未涉及的节点必须原样保留（id、type、dependsOn 一个字符都不改）',
    '- 图不允许有环；无依赖关系的并行 implement 节点 files 不得相交',
    '- implement 与 review 必须填白名单里的 agentId；approval 填 executor；route 两者都不填',
    '- 如果这条指令不需要改图，就原样交回当前这张图，不要为了显得有产出而乱改',
    `- 输出前自查一遍上述约束。标记：${PLANNER_AMEND_MARKER}`,
  );

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
 * 从改图 prompt 里读回「当前任务图」。
 *
 * 只给回放执行器用：它不启动任何进程，却必须交出一张基于当前图的合法新图，
 * 而它能看到的全部信息就是这段 prompt。放在这里而不是服务端，是因为
 * 这段文本由本模块生成——格式变了却忘了改解析方，是最容易漏的一类回归。
 */
export function extractCurrentDagFromPrompt(prompt: string): Dag | undefined {
  const anchor = prompt.indexOf(CURRENT_DAG_MARKER);
  if (anchor === -1) {
    return undefined;
  }
  const fenceStart = prompt.indexOf('```json', anchor);
  if (fenceStart === -1) {
    return undefined;
  }
  const fenceEnd = prompt.indexOf('```', fenceStart + 7);
  if (fenceEnd === -1) {
    return undefined;
  }
  try {
    const parsed = safeParseDag(JSON.parse(prompt.slice(fenceStart + 7, fenceEnd)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function issueKey(issue: DagIssue): string {
  return `${issue.kind}:${[...issue.nodeIds].sort().join(',')}`;
}

/**
 * 用 Agent 把一条自然语言指令落成对 DAG 的修改。
 *
 * 不合格就把校验问题回灌给同一个 Agent 重写，最多三轮——与 generateDag 同理：
 * 闸门的作用是给出可执行的修改指令，不是拒单。
 *
 * 交付只认文件，不从 stdout 捞 JSON：CLI Agent 的 stdout 是它自己的事件流，
 * 从中捞结构化结果必须猜格式，而「改图」比「从零拆图」更不能猜——猜错的图
 * 会让已经跑了一半的运行长出一张不对的图。
 */
export async function amendDag(
  goal: string,
  currentDag: Dag,
  instruction: string,
  catalog: AgentProfile[],
  execution: PlannerExecution,
  options: AmendOptions = {},
): Promise<AmendedPlan> {
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

  const maxAttempts = options.maxAttempts ?? 3;
  const issues: DagIssue[] = [];
  const seen = new Set<string>();

  // 同 generateDag：改图也用一次性目录。固定目录会让上一轮写下的交付文件
  // 在本轮 Agent 没写文件时被读回来，把上一次的图当成这一次的结果。
  const workspaceRunId = `amend-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = buildAmendmentPrompt(goal, currentDag, instruction, catalog, {
      lockedNodeIds: options.lockedNodeIds,
      previousIssues: issues,
    });
    const nodeId = `attempt-${attempt}`;
    options.signal?.throwIfAborted();

    let cwd: string;
    try {
      cwd = await execution.workspace.prepare(workspaceRunId, nodeId);
    } catch (error) {
      throw new DagGenerationError(
        `改图工作区准备失败：${(error as Error).message}`,
        attempt,
        issues,
        { cause: error },
      );
    }

    const argv = buildAgentArgv(agent, {
      prompt,
      workdir: cwd,
      policy: 'accept-edits',
    });

    const parser = createParser(agent.launch.parser);
    let answer = '';
    const collect = (events: ReturnType<typeof parser.push>): void => {
      for (const event of events) {
        if (event.kind === 'text' || event.kind === 'result') {
          answer += event.text ?? '';
        }
      }
    };

    const result = await execution.runner.run(
      {
        runId: options.runId ?? workspaceRunId,
        nodeId,
        agentId: agent.id,
        bin: agent.launch.bin,
        argv,
        stdin: agent.launch.stdin ? prompt : undefined,
        cwd,
        timeoutMs: agent.timeoutMs,
        signal: options.signal,
        policy: 'accept-edits',
      },
      (chunk) => {
        collect(parser.push(chunk));
        execution.onOutput?.(chunk);
      },
    );
    collect(parser.finish());

    const submitted = await readSubmittedPlan(cwd);
    // 读完再释放工作区，顺序不能反
    await execution.workspace.release(workspaceRunId, nodeId).catch(() => {});
    options.signal?.throwIfAborted();
    if (result.cancelled) {
      throw new DagGenerationError('规划执行已取消', attempt, issues);
    }

    if (submitted === undefined) {
      if (!result.ok && attempt === maxAttempts) {
        throw new DagGenerationError(
          result.timedOut
            ? `改图 Agent 超时（${Math.round(agent.timeoutMs / 1000)} 秒）`
            : `改图 Agent 执行失败：${result.error ?? `退出码 ${result.exitCode ?? '未知'}`}`,
          attempt,
          issues,
        );
      }
      if (attempt === maxAttempts) {
        throw new DagGenerationError(
          `Agent 没有把修改后的任务图写入 ${PLAN_FILENAME}：${truncate(answer || result.output, 400)}`,
          attempt,
          issues,
        );
      }
      continue;
    }

    const parsed = safeParseDag(submitted);
    if (!parsed.success) {
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
          `Agent 给出的图结构不合法：${truncate(JSON.stringify(submitted), 300)}`,
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
    `Agent 连续 ${maxAttempts} 次给出的任务图都没通过校验`,
    maxAttempts,
    issues,
  );
}
