# #1505 启动计时复现源

本分支保存 PR #1788 的历史测试补丁，以及下一轮正式验收生成器的原始源码。它是可复现材料；没有新增生产样本，也没有启用工作流或修改 main。

当前产品修复在 [PR #1788](https://github.com/alexj11324/Mikka/pull/1788)，head 26ccbfae27b553bc70ab52588368e7eb089fc362。其 tree a74b54fe14fed0ea34a600f9add9134b99f24c23 与受测本地 24316ea 相同。

## 历史补丁

patches/ 的七份文件保持当时原字节，包括原 IPC RED、跨作用域 RED、类型检查修正前状态和最终补丁。它们对应不同测试轮次，不能依次全部应用。准确配方见对应证据包的 validation-source-recipes.json；本目录 source-index.json 保存原 bytes、SHA256 和 Git blob，避免从最终版本猜测中间态。

完整 pnpm check 仍为 FAIL：已有 Settings authClient mock 缺口在 bb5 与候选同环境均复现；56 条后缀未执行。定向测试或归档不改变这个结果。

## 下一轮生成器

formal-renderer/ 的 render.py、base.yml.snapshot、workflow.template.yml.in 必须保持同目录；后两者的原字节由生成器校验。pins.unfilled.json 和 fields.json 保存待填字段及其证据来源。所有旧 pins 仅为历史基线，下一轮必须重新取得实际发布和 scope 证明；不得恢复旧正式 ref 或旧 scope。

历史 F433a 作为本归档提交的第二父对象保留，因此其原工作流可按 immutable commit 读取，但本归档 tip 不包含该历史工作流路径。它从未建立正式 ref、从未执行；原 bb5 scope 已清理。保存历史不等于重新激活。

这些文件只含生成源码、环境变量名称、公开标识/哈希和待填项，不含真实 token、密码、JWT 或私钥。原测试日志、失败、警告及运行环境证据单独保存，Git 源码不重复放入该报告包。
