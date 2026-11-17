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
├── data/              # 运行时 JSONL（不入库）
│   └── worktrees/     # 每个运行的节点 worktree（不入库；目标仓库由运行自己指定）
└── .github/workflows/ # CI
```

每个 package 内部统一为 `src/`（源码）+ `test/`（单元测试）。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js 20+、pnpm workspace |
| 语言 | TypeScript 5.x（严格模式） |
| 后端 | Fastify、Zod、SSE |
| 持久化 | 分片 JSONL 事件日志与 Git 产物 |
| 进程与 Git | Node.js child_process、Git 2.38+ |
| 前端 | React 18 + Vite、React Flow、Zustand、Tailwind CSS |
| 测试 | Vitest |

## 快速开始

需要 Node.js 20 及以上、Git 2.38 及以上，以及项目声明的 pnpm 版本。安装并登录本地 CLI Agent，例如 Codex CLI，然后启动编排器。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm local
```

打开 [本地看板](http://localhost:5173)，点击「新建运行」，输入需求并选择目标仓库和执行 Agent。服务会探测 PATH 中的 CLI，macOS 也可以使用 ChatGPT 应用自带的 Codex CLI。只有一个 Agent 时，规划、实现和审查可以使用同一个 CLI 的不同会话。

实现节点在独立的 Git worktree 内写入文件。审批和合并完成后，请查看运行详情中的 `run/<运行ID>` 分支。默认目标仓库是 `data/local/project`，可在新建运行页面改为本机项目路径。后端端口为 3000，前端端口为 5173。

`pnpm demo` 启动回放模式，使用单独的 `data/demo`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm local` | 构建并启动真实 Agent 模式，数据保存在 `data/local` |
| `pnpm demo` | 构建并启动回放演示，演示数据放在 `data/demo` |
| `pnpm dev` | 并行启动 API 服务与前端 |
| `pnpm dev:server` | 只启动后端（tsx watch） |
| `pnpm dev:web` | 只启动前端（Vite） |
| `pnpm build` | 构建全部 package |
| `pnpm typecheck` | 全仓库类型检查 |
| `pnpm test` | 运行各 package 单元测试与 `tests/` 集成测试 |
| `pnpm test:e2e` | 只运行 `tests/` 端到端测试 |

### macOS 桌面打包

在目标架构的 Mac 上使用 Node.js 20 和 pnpm 10.15.0。Apple Silicon 使用 arm64 版 Node，Intel Mac 使用 x64 版。

```sh
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
GIT_CONFIG_VALUE_0=git@github.com: \
pnpm install --frozen-lockfile

pnpm desktop:make
```

临时 Git 配置让锁文件中的 Electron 依赖通过 HTTPS 下载。首次打包需要联网下载 Electron。产物位于 `apps/desktop/out/`，包含按架构命名的目录和 `WorkflowOrchestrator-mac-<arch>.zip`。解压 ZIP 后可在本机打开 `WorkflowOrchestrator.app`。

此命令生成本地测试包。面向其他 Mac 分发时，需要另做 Developer ID 签名与 Apple 公证。应用内运行真实 Agent 还需要在本机安装并配置对应 CLI。


## 协作约定

- 分支：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`，不直接改 `main`。
- 提交信息建议使用 Conventional Commits：`feat(core): 调度就绪集合`。
- 运行期产物一律不提交：`node_modules/`、`dist/`、`data/`、`.worktrees/`（历史遗留）、`.env`。
- 新增设计决策写入 `docs/design/`，新增需求材料写入 `docs/requirements/`。

## 当前进度

本地原型支持任务图规划、依赖调度、Git 工作区隔离、审查回修、人工审批、分支合并和运行恢复。运行详情通过 SSE 更新。
