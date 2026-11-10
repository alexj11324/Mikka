# PR #1782 最新 head CI 工件核验 — ce6ad923

产品 `ce6ad923bbb449023783052d0848db22e4360f1d`，tree `dffda64a4975b22cfc649908a8c5e19749ea8a96`。PR合成提交 `08aea3e5533412337d531ca0dc1f77fc06565f60`，有序parents=[ab2d00a4,ce6ad923]，与产品同tree。

## 执行与结果

[原 CI 42761565545/1](https://github.com/alexj11324/Mikka/actions/runs/42761565545) 和本 head 全部14条工作流成功。2026-11-10 06:34 UTC附近的实际API读回仍为45个checks：41 SUCCESS及4个原有PR条件SKIP，无新增测试跳过、禁用或隔离。

[独立工件reader 42769106208/1](https://github.com/alexj11324/Mikka/actions/runs/42769106208)，job129672456182，**SUCCESS**。Reader为 `d77b0c8eb27aa27b738dc0b51e253324f641756b`，tree `8fe2443d12f8a1e8c12b9de6bc99c8bf0a073c1e`。固定六份原ZIP实际下载共15,342,134 B、323成员，长度/SHA256/CRC/精确文件集合全通过。

| 工件 | 验证结果 |
|---|---|
| 真实kernel | IPv4/IPv6共12项；含accept前无skuid纯ACK正例和ACK携带payload的拒绝负例 |
| Daemon | 1,595 passed，原5 skipped严格限制原两文件；关键28+22+10=60全部通过 |
| PG XML | 来自DB4/4的实际41个testcase、36个必需命名检查；failure/error/skip全部0 |
| Image | 合成模型31次回复；daemon8检查/7清理、desktop6检查/4清理、Mailpit/MinIO/双副本全部通过 |
| Apple native | 51屏×2主题=102对比，10项smoke、8项lifecycle；311PNG+3JSON；5组冷启动保留原测量合同 |
| Apple package | 2个固定JSON、同一不可变签名包、3个独立Keychain加密进程、退出与清理全部通过 |

## 保全文件

[ci-reader.json](./ci-reader.json) 是reader实际输出的95,665 B原JSON，**无尾换行**，SHA256 `10860f1046121bc74f640bfed3bc0f53b28223eac3c60083498a394a31c199f8`。包含六工件身份、每成员CRC/SHA/长度与闭集判定。Root实际读回、重算摘要并逐类重验输出，记录于 [root-review.json](./root-review.json)。

这份报告不把所选PG XML扩大成全部数据库套件；完整80个required脚本/334文件由原CI日志另证。Image回复仍标为synthetic，不当生产真实订阅；cold startup没有新增速度阈值。

## 辅助reader失败的保留与修正

三次失败 [42767660674](https://github.com/alexj11324/Mikka/actions/runs/42767660674)、[42768028245](https://github.com/alexj11324/Mikka/actions/runs/42768028245)、[42768596399](https://github.com/alexj11324/Mikka/actions/runs/42768596399) 均保留。分别修正Vitest5逐项skipped编码、实际10项smoke及生命周期执行顺序、成功路径已关闭后不会重复生成finally electron-close标签。修正均核对固定生产者源码和既存原日志，只更改独立reader两文件；没有改动产品测试、门禁、预算或产品head。

实际native JSON的两组清理各6阶段全部passed。Lifecycle在设置passed=true前已经await应用关闭并停止精确daemon，finally仅对剩余进程记录electron-close；仍要求nativeCleanup、fixture清理、租约释放和双账户sealed状态恢复。
