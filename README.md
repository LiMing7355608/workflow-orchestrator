# Workflow Orchestrator

Workflow Orchestrator 是第二组开发的通用、可定制软件工程工作流原型。输入产品想法或设计规格，设计 Agent 可逐轮澄清需求，PM Agent 将规格拆成带依赖、交付路径和验收条件的开发任务。编排器校验后生成可视化 DAG（有向无环图），用节点表示任务，用连线表示执行依赖。

**需求访谈 → PM 任务拆解 → 编排图与人工确认 → 实现、审查和交付**

已有明确规格时可以直接进入 PM 拆解。确认任务草案后，执行 Agent 在各自的 Git 工作区中完成任务，经过审查和审批后集成交付。

- 设计基线：[docs/design/第二组设计文档.md](docs/design/第二组设计文档.md)
- 需求确认过程：[docs/requirements/第二组-软件工程项目需求确认工作流.md](docs/requirements/第二组-软件工程项目需求确认工作流.md)

## 目录结构

```text
.
├── apps/desktop/      # Electron 桌面端与打包脚本
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
├── data/              # 本地开发与回放数据（不入库）
└── .github/workflows/ # CI
```

每个 package 内部统一为 `src/`（源码）+ `test/`（单元测试）。

## 从想法到任务图

- **规格访谈**在「新建运行」中进行。填入产品想法和目标目录，选择设计 Agent 和模型，再逐轮回答带建议的问题。切换页面后，可从「运行记录」继续未完成的访谈。遇到需要讨论的规格问题，可以发起多 Agent 会议并将方案纳入访谈。生成的规格可直接排版阅读、看源文或下载 Markdown。检查规格后，点击「确认规格并开始拆解」。已有规格可选「直接使用规格」。访谈方式参考 [grill-me](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md) 和 [grilling](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)。
- **PM 拆解与核对**生成交付路径、验收条件和任务依赖。确认草案前可进入「临时编辑」，拖拽卡片调整画布位置，修改任务名称、说明和依赖。保存后校验结构和依赖，提交确认后才派发。DeepSeek Harness 在规划时直接回复任务图 JSON，由编排器校验和保存。重试原因可在事件流中查看。
- **流程对话**分为总控与产品经理、工程师、审查员三个角色。可查看角色调用和回复，并把建议带到总控发送。总控用于补充要求、重新拆解及调整尚未开始的任务。节点详情提供时间线、交付与控制操作。
- 「任务拆解」可按依赖层展开，查看计划文件、验收条件和已落盘的文件。「编排图」支持定位正在执行或待审批的节点，放大、缩小、全屏以及在画布上展开卡片。活动连线关联真实执行状态，节点显示开始、结束和停止时间。
- **运行监控**位于单次运行的「Agent 监控」页，按执行 Agent、编排器、审查与交付展示，卡片显示选用的模型。点击卡片或时间条可打开对应对话。流式片段合并为完整消息，任务图和核对结果先显示摘要。长规格和右侧「协作黑板」支持展开和滚动。
- **协作黑板**用于查看和发布项目决定。实现和审查 Agent 在开始执行时取得最近的共享消息和自己的续跑摘要，可以用 `BLACKBOARD:` 在最终答复中分享决定、问题或结果。续跑摘要按运行、Agent 工具和节点分开。
- **Agent 管理**汇总进行中的任务和工作中的 Agent 数量。在「客户端与接口设置」可探测本机客户端，也可通过服务地址和 API 密钥接入 OpenAI 兼容或 Anthropic Messages 接口，用于规格访谈、会议、任务拆解和文本审查。新建运行会按角色和客户端记住所选模型。
- **运行记录**可单独删除规格访谈聊天，也可删除运行及其产物。删除时会同步清理编排器记录的受支持本地 CLI 会话。运行中的任务需要先停止，访谈可以在删除时取消当前轮。

新建运行的数据位于目标工程的 `.workflow-orchestrator/`。目录由 Git 本地忽略规则排除。

- `runs/<运行 ID>/` 下有访谈记录、确认规格 `spec.md`、任务草案 `plan-draft.json`、确认后的任务图 `plan.json`、事件日志、节点 diff 和 `memory/`。节点完成后把已确认的文件保存到 `deliveries/<节点 ID>/<版本>/`。审批合并后，普通文件写入 `output/<版本>/`，并保留 `output.zip`。可从「任务拆解」查看目录、下载节点文件或获取集成 ZIP。
- `meetings/<会议 ID>/` 保存会议设置、发言、调用时间和 `solution.md`。在「会议协作」中可手动指定角色、职责、提示词与模型，也可让主持模型分配成员。编排视图展示从成员发言、主持收敛到方案交付的状态。点击角色卡片或时间条可查看发言。成员每轮并行发言，后续轮读取前轮意见，主持人汇总方案。人工可在讨论过程中补充意见，并在会后阅读、下载方案或用它新建开发运行。
- `worktrees/<运行 ID>/` 下是实际执行目录和集成工作区。显式配置的 `AGENT_WORKTREE_DIR` 有优先级。
- 应用的数据根保存运行位置索引，早期版本的旧日志仍可读取。删除运行会清理本轮创建的文件和工作区，并保留已并入正式分支的代码和在其他工作区签出的分支。

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

### Windows 本机桌面同步

在仓库根目录运行以下命令，构建并更新日常使用的桌面目录。关闭该目录里运行的应用后再同步。

```powershell
.\scripts\sync-desktop.ps1 -Destination 'D:\projects\WorkflowOrchestrator-win32-x64'
```

脚本暂存并校验新包，替换安装目录时会保留上一版作为备份。本机设置和运行索引默认位于用户目录的 `.workflow-orchestrator`，工程产物各自保存在运行选择的目标目录。

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

本地原型已贯通需求访谈、会议协作、任务图规划、依赖调度、Git 工作区隔离、审查回修、人工审批、分支合并和运行恢复。运行详情通过 SSE（服务端事件流）实时更新。
