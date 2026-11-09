# #1505：Codex 0.167 匿名预启动兼容性只读核对

## 结论与证据边界

actual Mikka `7848e79df9c5af67e526aeed1c828858db392066` 的 `anonymous-codex-spare.ts` 第 138 行只接受初始化 `userAgent` 中的精确 `0.166.0`，随后才发送 `initialized`。本轮缓存原件记录官方二进制版本为 `0.167.0`。这提供了一条明确的拒绝路径，支持对经过核对的 `0.167.0` 做显式版本兼容。

原始生产诊断没有保存实际 initialize 响应；本核对没有运行真实 Codex 二进制。因此不能把静态拒绝机制写成已捕获的生产原生进程轨迹，也不能据此宣称预启动采纳、发布或性能验收通过。

## 固定官方来源

| 官方发布 | tag 对象 | commit |
|---|---|---|
| rust-v0.166.0 | `593389380740f7b4762771573c447ccfdc59742f` | `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` |
| rust-v0.167.0 | `cb41599ccbe371272892f156286a236aa097bada` | `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a` |

两者都从 `openai/codex` 官方发布 tag 解析到精确 commit。下列判断均来自固定源码，不依据可漂移的 main。

## 与本修复相关的协议对照

| 检查项 | 实际差异 |
|---|---|
| `InitializeParams`、`InitializeResponse` | 两版结构逐字相同；`clientInfo`、`experimentalApi` 和 `userAgent` 契约保留 |
| 初始化处理器 | 唯一差分是新增 `requiredHumanApproval` opt-in；该字段默认 false，且同时要求 experimentalApi |
| `initialized` 通知 | 两版定义相同 |
| `get_codex_user_agent` 所在文件 | 两版全文逐字相同；版本来自编译期 `CARGO_PKG_VERSION` |
| `ThreadStartParams` | 整个结构逐字相同，包括 cwd、config、approvalPolicy、sandbox |
| `thread_start_inner` 到 `thread_start_task` 区间 | 逐字相同；保留每个 thread 的 cwd/config override 与启动路径 |
| `config_manager.rs` | 全文逐字相同；请求 config 继续转换并合并到 thread 配置 |

0.167 的 login crate 继承 workspace version，而该 workspace 明确为 `0.167.0`。初始化响应通过同一 user-agent 生成函数产生包含该版本的标识。线程处理器其他差分仅涉及 section 移动通知及 thread items 读取重构，未进入上述启动区间。

主要可引用文件：

- [官方 0.167 初始化处理器](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/initialize_processor.rs)
- [官方 0.167 初始化协议类型](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-protocol/src/protocol/v1.rs)
- [官方 0.167 user-agent 生成](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/login/src/auth/default_client.rs)
- [官方 0.167 thread/start 参数](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
- [官方 0.167 thread/start 实现](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/request_processors/thread_processor.rs)
- [官方 0.167 配置管理器](https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/app-server/src/config_manager.rs)

`review.json` 包含 10 项实际静态比较结果、Mikka 拒绝行的字节身份及每个主来源的哈希。`source-manifest.json` 记录 17 份原始源码，7 个 blob 身份另与 GitHub Git API 核对。三个完整差分保存在本目录，原始源码缓存位于 `upstream/`。

## 对早前判断的纠正

曾使用过窄的 rg 模式搜索普通点号，漏掉正则源码中的转义点号，错误地称没有精确版本判断。该结论已撤回；现已全文回读 Mikka 文件并核对 blob `00f476c51799a68c4af5edc38d9a62c91aeea545`、SHA256 `b7fac1b0fadd1374377ba27b9fe62d60a70a746218fe029237acf870855d6035`。

本次未修改产品代码、CI 门槛、正式计时公式或普通 Task 字段；未读取生产秘密、重新下载 Actions 原件或日志，未调用模型、创建云资源、写入 Git 对象或 ref。只完成源码比较，未冒称真实 0.167 原生协议复现。
