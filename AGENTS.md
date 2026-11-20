# 项目交付约定

- 修改桌面功能后，构建并验证源码、桌面程序和项目输出。将源码提交至本轮工作分支，核对 GitHub 上对应的提交和 CI。
- 在 Windows 本机把新包同步到用户日常双击的 `WorkflowOrchestrator-win32-x64` 安装目录。当前机器使用项目外层的 `ai工作流\WorkflowOrchestrator-win32-x64`。开发仓库 `apps\desktop\out` 是构建目录。
- 通过 `scripts/sync-desktop.ps1` 指定安装目录。同步前确认程序未在此安装目录运行，同步后用隔离的数据目录测试同一个可执行文件。团队可从 GitHub 取得源码，桌面包供本机使用。
