# #1783 录像、截图和报告归档

本页供发布者与审阅者核对 #1783 的云 Linux 验收证据。归档固定在原执行
提交 `40376665ac416ce2228c08b60d7ea8cee97a3de6`，本轮恢复工作独立复核
文件、媒体和业务绑定；这些历史结果不代表后续合流提交或生产已通过。

## 证据入口

以下文件保留原始字节，原 manifest 未改写：

- [带录像和截图的索引](cloud-linux-40376665-final03/index.html)
- [原执行说明](cloud-linux-40376665-final03/README.md)
- [原时间、命令与测试回执](cloud-linux-40376665-final03/receipt.json)
- [原大小和 SHA-256 manifest](cloud-linux-40376665-final03/manifest.json)
- [本轮独立复核回执](independent-review.json)
- [hosted #59 数据、行为和模板外观复核](hosted-review.json)
- [activity 原始读回](cloud-linux-40376665-final03/activity-readback/activity.json)
- [正常上传、不可变文档和清理回执](cloud-linux-40376665-final03/activity-readback/proof.json)

## 测试与媒体对应

四个阶段的录像记录实际云终端执行，截图分别记录开始、执行中和结果：

| 阶段 | 原执行结果 | 录像 | 结果截图 |
| --- | --- | --- | --- |
| PostgreSQL 门禁与完成顺序 | 202/202 | [83.2 秒](cloud-linux-40376665-final03/01-postgresql-gates.mp4) | [202 项通过](cloud-linux-40376665-final03/01-postgresql-gates-result.png) |
| Vite/Nitro 真实 HTTP | 8/8 | [41.7 秒](cloud-linux-40376665-final03/02-real-http.mp4) | [8 项通过](cloud-linux-40376665-final03/02-real-http-result.png) |
| CLI、daemon、真实 FFmpeg | 91+10 项通过 | [22.1 秒](cloud-linux-40376665-final03/03-cli-daemon-ffmpeg.mp4) | [运行与压缩回读](cloud-linux-40376665-final03/03-cli-daemon-ffmpeg-result.png) |
| 正常上传和 activity 读回 | 15 个断言通过，单独计数 | [54.9 秒](cloud-linux-40376665-final03/04-activity-registration.mp4) | [读回与清理完成](cloud-linux-40376665-final03/04-activity-registration-result.png) |

测试合计 **311/311，0 失败、0 跳过**。原命令、结束时间和退出码在
`receipt.json`。第四阶段使用隔离测试库中的合成 task 图验证真实 HTTP
传输，没有执行生产模型或真实 GitHub App 任务。

## 独立复核结果

原 manifest 中 53 个文件的大小和 SHA-256 全部一致；目录只有这些文件及
manifest 自身。6 个 MP4 和 14 个 PNG 经 FFmpeg 全量解码通过，12 张
阶段截图经逐张查看，画面对应命令启动、执行与结果。33 个文本文件未命中
GitHub token、私钥或 JWT 的高置信格式；原运行另有已知凭据值审计回执。

前三段录像及其结果截图共 6 份媒体，与 activity 中的任务、producer run、
attempt、大小和固定路径一致；acceptance 中的同一媒体同时绑定原 candidate。
4 份文档的真实下载字节、不可变版本、producer run 和 candidate 一致。
所有媒体链接与报告链接均指向原 loopback 应用。数据库及临时资源已清理，
这些 loopback URL 是原执行时的路由证据，查看归档请使用本页相对文件链接。

原 manifest 的 SHA-256 是
`1db726eab5a4be6ddd2fc6bf27fc61269c0df32a4fbcee76c0f992936b5ca992`。

## 后续核验

本轮合流源码 `1efe99fcdf03f8b386682b92b0508cc164d2e179` 在独立云 Linux
通过 178/178 项测试：57 项 FFmpeg/验收 driver/安装诊断、104 项 daemon、
5 项 worker 安装投影和 12 项 runtime refresh。生成路由检查为 243 个
路由、315 个方法，工作区前后干净，开发 sandbox 已停止。详见
[源码复核与清理回执](cloud-linux-1efe99fc-resume/receipt.json)。大日志下载
遭 connector 截断，因此这里只保存已观察结果的明确标注摘录和完整小日志；
最新 head 的 Actions CI 仍须全绿。

生产真实任务另按
[生产验收步骤](../production.md)执行，记录缺证据拒绝、有证据同源读回、
部署版本和清理结果，再将最终回执写回
[#1783](https://github.com/alexj11324/Mikka/issues/1783)。
