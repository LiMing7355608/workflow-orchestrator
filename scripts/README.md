# 脚本

放置演示与运维辅助脚本，例如：

- `demo-<阶段>.ts`：按设计文档第 13 节的原型实施路径，端到端演示单节点闭环、串并行 DAG、交叉审查、人工审批。
- `seed.ts`：写入演示用的工作流与节点数据。
- `reset-data.ts`：清理 `data/` 下的本地 SQLite 与事件日志。

脚本通过 `tsx` 运行，依赖安装后可直接执行：`pnpm exec tsx scripts/<name>.ts`。
