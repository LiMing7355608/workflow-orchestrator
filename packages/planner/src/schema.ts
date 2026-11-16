import { z } from 'zod';

/**
 * Planner 的输出契约。
 *
 * 冻结前的 DAG 必须能通过这一层校验；冻结后图结构不再修改，
 * 成为执行阶段唯一的事实来源。
 */

export const nodeTypeSchema = z.enum(['implement', 'review', 'approval', 'route']);

export const dagNodeSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, '节点 id 只允许小写字母、数字与连字符'),
  type: nodeTypeSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  dependsOn: z.array(z.string()).default([]),
  /** 独占文件范围。并行实现节点的集合不允许相交 */
  files: z.array(z.string()).default([]),
  /** 实现与审查节点必填，审批与路由节点留空 */
  agentId: z.string().min(1).optional(),
  /** 人类审批人或编排器节点的展示名 */
  executor: z.string().min(1).optional(),
  /** 审查驳回的最大回退次数，超限后升级人工 */
  maxAttempts: z.number().int().positive().max(10).default(3),
});

export const dagSchema = z.object({
  specVersion: z.string().min(1).default('v1.0'),
  title: z.string().min(1),
  summary: z.string().default(''),
  nodes: z.array(dagNodeSchema).min(1, 'DAG 至少需要一个节点'),
});

export type DagNode = z.infer<typeof dagNodeSchema>;
export type Dag = z.infer<typeof dagSchema>;

/** 解析并校验结构。结构不合法时抛 ZodError，由调用方决定怎么报。 */
export function parseDag(input: unknown): Dag {
  return dagSchema.parse(input);
}

export function safeParseDag(input: unknown) {
  return dagSchema.safeParse(input);
}
