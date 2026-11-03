# 显式初始化执行环境，并以独立验证和真实界面验收交付

- Date: 2026-11-03
- Source: Alex 在订阅 Agent 修复对话中确认采用 Warp 的环境初始化、仓库绑定和独立验证做法，同时保留官方订阅；此前明确要求：“请严格按照官方的文档行事，如果我的指令和官方文档有冲突，依照官方文档进行处理”。
- Rule: —
- Replaces: —

每个 fresh instance 都显式完成 setup、目标仓库 clone/checkout、依赖准备和身份检查，再启动 native harness。记录实际仓库 origin、ref/HEAD、工作目录及 app/worker 来源；不能假设新实例继承父实例的目录、仓库或依赖，也不能用旧实例成功代替新实例验收。保留 Codex、Claude Code 的完整官方安装与工具；遵循 E2B/CLI 官方安装及扩展方式，在项目适配层处理初始化，不自行裁剪官方包或改删官方模板文件。

执行 Agent 必须先对照任务检查实际 origin、HEAD 和仓库文件。仓库错误时，Agent 在用户当前授权范围内选择正确仓库，通过宿主重新检查授权并建立新 clone 和执行绑定，保留原工作区及历史；不能把修改 origin 或错误工作区内的嵌套 clone 当成交付。切换后继续使用原先冻结的官方订阅、模型和 harness，不能回退其他账号、API key 或模型。

实现、独立 review 和独立 verify 分别记录真实 run/session 和结果。review/verify 固定到同一候选 Git 快照，以独立读取和实际检查取得证据；它们不能改换候选仓库或用执行 Agent 的总结代替验证。最终保留正常 owner 界面中的候选、环境、证据、待验收状态和实际验收后的截图及持久化回执。尚未完成的订阅执行、仓库自主切换、续跑或界面验收必须明确列为未验收，不能因代码合并、CI 通过或 Agent 声称成功而宣布修复完成。

这些是本项目采用的工程约束。Warp 文档支持 fresh workspace、环境 setup、原生 harness、分阶段审查与可见行为验证的参考模式；它没有直接规定本项目的目录结构、逐文件保留规则或 Agent 自主选库算法，不能据此声称 Warp 已裁定历史删包行为。Warp Automation Platform 文档所述云端 Codex/Claude Code API balance 计费仅用于界定参考范围，不是迁移方案；本次验收继续使用用户已授权的 Codex 和 Claude Code 官方订阅。

官方原始来源（2026-11-03 查阅）：

- [Environments: what an environment includes](https://docs.warp.dev/platform/environments/#what-an-environment-includes)；[control plane and execution plane](https://docs.warp.dev/factories/infrastructure-and-security/#control-plane-and-execution-plane)。
- [Codex harness](https://docs.warp.dev/platform/harnesses/codex/)；[Claude Code harness](https://docs.warp.dev/platform/harnesses/claude-code/)；[what stays the same](https://docs.warp.dev/platform/harnesses/#what-stays-the-same)。
- [Factory stages](https://docs.warp.dev/factories/how-factories-work/#stages)；[models and harnesses per agent](https://docs.warp.dev/factories/factory-agents/configuration/#choose-models-and-harnesses-per-agent)；[computer-use verification](https://www.warp.dev/blog/how-to-build-a-cloud-software-factory-computer-use-verification)。
- [Cloud OpenAI authentication and billing](https://docs.warp.dev/platform/harnesses/authentication/#create-an-openai-api-key)；[Cloud Anthropic authentication and billing](https://docs.warp.dev/platform/harnesses/authentication/#create-an-anthropic-api-key)；[where your team stays in charge](https://docs.warp.dev/factories/how-factories-work/#where-your-team-stays-in-charge)。
