/**
 * @orchestrator/planner —— Planner 输出契约与 DAG 冻结校验。
 *
 * 计划在这里被拆成节点图，校验通过后才会被编排放行执行。
 * 校验刻意严格：不合法就拒绝冻结，而不是修一修再放过去。
 */

export {
  dagNodeSchema,
  dagSchema,
  nodeTypeSchema,
  parseDag,
  safeParseDag,
} from './schema.js';

export type { Dag, DagNode } from './schema.js';

export { availabilityOrder, validateDag } from './validate.js';

export type { DagIssue, DagIssueKind, ValidationResult } from './validate.js';

export {
  DagGenerationError,
  PLANNER_PROMPT_MARKER,
  generateDag,
  pickPlannerAgent,
  usablePlannerAgents,
} from './generate.js';

export type {
  GeneratedPlan,
  PlannerExecution,
  PlannerOptions,
} from './generate.js';
