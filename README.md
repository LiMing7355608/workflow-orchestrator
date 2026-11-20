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

## 从想法到任务图

- 在「新建运行」选「需求访谈」，填一句产品想法和目标目录，选择设计 Agent 和模型。设计 Agent 沿决策依赖逐轮提问，每题带建议。答复后可以检查规格、补充修订，再点「确认规格并开始拆解」。已有明确规格时可以选「直接使用规格」。访谈方式参考 [grill-me](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md) 调用的 [grilling](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)。
- PM 拆解时为每个实现节点列出具体交付路径，并为实现和审查节点写入可执行的验收条件。系统校验任务图，并由核对 Agent 检查需求覆盖、交付和验收条件。可按依赖展开草案和节点，在编排器对话里补充要求并重新拆解。确认草案后才派发实现任务。执行中可停止、向节点留言或通过编排器修改尚未开始的任务。
- 「任务拆解」可按依赖层展开，查看计划文件、验收条件和已落盘的文件。「编排图」支持定位正在执行或待审批的节点，放大、缩小、全屏以及在画布上展开卡片。活动连线关联真实执行状态，节点显示开始、结束和停止时间。
- 进入运行详情右侧的「协作黑板」查看或发布项目决定。实现和审查 Agent 在开始执行时取得最近的共享消息和自己的续跑摘要，可以用 `BLACKBOARD:` 在最终答复中分享决定、问题或结果。续跑摘要按运行、Agent 工具和节点分开。
- 「Agent 管理」显示执行成员、调度、产物和报告。运行中的调用路径带动效，时间图谱可点选并回看。回放模式会标明数据来源。运行列表可删除不用的记录。仍有调用或调度在进行时，停止后再删除。

新建运行的数据位于目标工程的 `.workflow-orchestrator/`。目录由 Git 本地忽略规则排除。

- `runs/<运行 ID>/` 下有访谈记录、确认规格 `spec.md`、任务草案 `plan-draft.json`、确认后的任务图 `plan.json`、事件日志、节点 diff 和 `memory/`。节点完成后把已确认的文件保存到 `deliveries/<节点 ID>/<版本>/`。审批合并后，普通文件写入 `output/<版本>/`，并保留 `output.zip`。可从「任务拆解」查看目录、下载节点文件或获取集成 ZIP。
- `meetings/<会议 ID>/` 保存会议设置、发言、调用时间和 `solution.md`。在「会议协作」中可手动指定角色、职责、提示词与模型，也可让主持模型分配成员。成员每轮并行发言，后续轮读取前轮意见，主持人汇总方案。人工可在讨论过程中补充意见，并在会后用方案新建开发运行。
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

本地原型支持任务图规划、依赖调度、Git 工作区隔离、审查回修、人工审批、分支合并和运行恢复。运行详情通过 SSE 更新。
