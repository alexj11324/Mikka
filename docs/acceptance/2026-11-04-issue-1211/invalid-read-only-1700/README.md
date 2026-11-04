# 17:00–18:00 UTC 候选窗口：失格，未取得 before

这是一份失败与收尾记录，不是一小时流量对比。关联 #1210、#1211、#1212；#1219 / #1220 / #1230 / #1231 / #1233 / #1234 均不能用这次尝试声称通过小时验收。

## 实际发生的事

正常 Owner UI 于 2026-11-04 16:48:30 UTC 发出一次任务。生产固定为 `66327f8400a0f0d930a0124340db02062df13671` / `dpl_CCCPtfy9kHKJwJMVuDCoT99AVN5u`。实际运行 `bacfa72c-7178-4c5a-84cf-f972f07b17f0` 于 16:50:15 开始，官方 Codex `gpt-6-luna`，一个原生订阅 claim、原连接 revision 2、实际 SID 均已保存。

固定核心为 v3，digest `29ced87c9f94c51c49a8d81d0f1eedc4f4cf7f1b49d5d19702532765dc29ad09`。真实 Owner event 与完整派发正文逐字匹配；冻结 run 中保留核心全文，Host handoff goal 与 Owner prompt 完全一致。没有替换模型、路径、凭据或第二个运行。

运行只调用了 `inspect_artifact(package.json)`，读到当前工作树 HEAD 66327f8。它没有读取固定源 2a0e398，没有完成任何审阅项或测试。随后 `report_blocked` 报告 `native_shell_unavailable_and_fixed_source_mismatch`，16:52:42 正常终止为 stopped / blocked，早于拟定窗口。

## 根因与边界

我们的 v3 验收合同要求 `readOnly:true`，同时要求 Git 命令与测试。生产的 `rawCliShellAvailable` 明确只在非只读且安装权限为 allow 时启用原生 shell；Codex 配置与给模型的指令一致。**这是验收合同与已有能力不相容，不能为通过测量放宽产品权限。**

后续可执行合同必须另行冻结新 digest；旧 15:00 与本次 17:00 尝试继续失格。没有将相邻小时、空闲或提前完成补足为一小时。版本 observer 在首次 17:00 采样前已终止（exit 143），计划中的版本和 Neon 采样均为 0，未触发小时 collector。

## 正常收尾

先用正常 UI 取消 issue；这没有改变 Factory waiting / revision 3。随后正常 Coordinator 取消误用了已有 route eventId，服务端在写入前以 `factoryReplayMismatch` 拒绝，原失败保留。核对幂等实现后，用一个新的取消请求 UUID 正常纠正一次。

17:11:38 UTC 的独立 SELECT 确认：Factory cancelled / revision 4，唯一 attempt cancelled；**原 agent_run 仍为 stopped / blocked，原 SID 未变**，没有候选或后继运行。Coordinator 文本把 attempt 状态称作原运行 cancelled 不准确，本记录以实际存储结果为准。临时模型优先项仅在 current 等于保存的 post 指纹时移除；原四项和八个聊天选择保持不变。

## 文件

- `acceptance-summary.json`：非秘密范围、模型、实际 claim、prompt hashes、两次取消结果和设置恢复守卫。
- `non-delta-evidence.json`：原运行非增量事件的完整窄记录。
- `window-status.json`：失格窗口和已停止 observer 的元数据。
- `cleanup-independent.json`：主代理在 17:11:38 UTC 独立读取的最终状态。

summary 的 evidenceFiles 还列出保留于验收工作目录的完整控制会话与原 SELECT。此公开目录只包含上述窄证据，不公开账号配置或凭据。
