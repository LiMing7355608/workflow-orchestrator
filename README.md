# Workflow Orchestrator

基于图的 Agent 编排器：把一个模糊的开发目标拆解为 DAG 子任务，由 Worker 在独立 Git worktree 中执行，经独立审查与人工审批后闭环交付。

- 设计基线：[docs/design/第二组设计文档.md](docs/design/第二组设计文档.md)
- 需求确认过程：[docs/requirements/第二组-软件工程项目需求确认工作流.md](docs/requirements/第二组-软件工程项目需求确认工作流.md)

## 目录结构

```text
.
├── packages/
│   ├── core/          # 图调度、节点状态机、事件总线、worktree 管理
│   ├── planner/       # Planner 调用与 DAG schema 校验
│   ├── server/        # Fastify HTTP 服务、SSE、REST
│   └── web/           # React + React Flow 监督看板
├── tests/             # 跨包端到端测试（vitest）
├── docs/
│   ├── requirements/  # 需求确认工作流与需求材料
│   ├── design/        # 设计文档与架构决策
│   ├── diagrams/      # 架构图、流程图源文件
│   ├── meetings/      # 会议记录
│   └── reports/       # 阶段报告、周报
├── scripts/           # 演示、数据初始化等辅助脚本
├── data/              # 运行时 SQLite / JSONL（不入库）
├── .worktrees/        # 每个实现节点的 Git worktree（不入库）
└── .github/workflows/ # CI
```

每个 package 内部统一为 `src/`（源码）+ `test/`（单元测试）。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js 20+、pnpm workspace |
| 语言 | TypeScript 5.x（严格模式） |
| 后端 | Fastify、Zod、SSE |
| 持久化 | SQLite + Drizzle ORM、JSONL 事件日志 |
| 进程与 Git | execa、node-pty、simple-git |
| 前端 | React 18 + Vite、React Flow、Zustand、Tailwind CSS |
| 测试 | Vitest |

## 快速开始

```bash
corepack enable          # 启用 package.json 中声明的 pnpm 版本
pnpm install
pnpm dev                 # 同时启动 server(3000) 与 web(5173)
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 并行启动 API 服务与前端 |
| `pnpm dev:server` | 只启动后端（tsx watch） |
| `pnpm dev:web` | 只启动前端（Vite） |
| `pnpm build` | 构建全部 package |
| `pnpm typecheck` | 全仓库类型检查 |
| `pnpm test` | 运行各 package 单元测试与 `tests/` 集成测试 |
| `pnpm test:e2e` | 只运行 `tests/` 端到端测试 |

## 协作约定

- 分支：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`，不直接改 `main`。
- 提交信息建议使用 Conventional Commits：`feat(core): 调度就绪集合`。
- 运行期产物一律不提交：`node_modules/`、`dist/`、`data/`、`.worktrees/`、`.env`。
- 新增设计决策写入 `docs/design/`，新增需求材料写入 `docs/requirements/`。

## 当前进度

仓库骨架与工具链已就位，业务逻辑待按设计文档第 4–10 章逐步实现。原型实施路径见设计文档第 13 节。
