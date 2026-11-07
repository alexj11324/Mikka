# Coordinator 后续验收：禁用准备稿（batch1615 V2）

本稿由新的离线恢复准备器生成。旧执行环境不可用，不能将本稿或新四文件哈希冒充旧准备器的字节恢复。
本稿没有执行生产登录、模型、SQL、部署或控制激活，也不构成新的生产通过证明。

## 源码与禁用边界

应用源码输入：@APPLICATION_SHA@，tree：@APPLICATION_TREE@。
这只是不可变 Git 源码绑定；真实 production alias、READY、公开版本及发布配置需由执行者另行核实。

十二个来源 pin 均按实际应用 Git blob 校验：原十项，加上实际 read-observer 运行时依赖和 components/swr-defaults.tsx 接线来源。只接受已审 ad224/a65 漂移及 0d379dd92fd2d7b3f2b307030c3bcd8234426d0e 中 channel、use-live-key、read-observer、SWR defaults 的精确字节；不自动接纳 db988 或未来变更。decoder 固定 490572a956f7675c1305f15394d75e1f6634cf3440da17fb3376dfb5189cf4e4。加载器只将相对导入解析到已固定的运行时模块，拒绝未列目标、外部包和越界路径。Hook、Coordinator 组件和 SWR defaults 仅核来源，不在 Node 渲染 React。

本版明确输出十一条路径：原八条，加 live-worker.mjs、live-worker-offline.mjs、live-consumer.test.mjs。worker 使用实际源码 readBoundary/readFresh/observeSWRRead/acceptSWRRead/failSWRRead，读取正常 RPC 快照后才接受并提交同一对象；保留 owner/namespace、required+held+local revision、local-write identity 与关闭守卫。离线平台夹具的 fixture-read 命令只在测试模块中，生产 worker 不接收该命令。没有复制或改写产品算法。

继续使用原 ACME 自有工作区与 Haiku/Luna retained fixture receipt，不重建、不重新选模型。普通停止/工具未覆盖修正来自独立恢复 checkpoint 344fafb353d1128f89475bc827a404eff4520451，其四文件已单独离线 RED→14/14 GREEN；本稿没有新增生产 Stop 成绩。

continue.json 完全保留 fcce 原件：enabled=false、phase=tool、expectedSha=null、cacheTurns=3。continuation workflow 的 MIKKA_STOP_CASE 仍是 during_tool。
presence workflow 保持原 literal false 和空应用 SHA；legacy resume workflow/control 原样，不给没有 enabled 字段的旧控制文件添加或修改字段。
MCP workflow 保留 literal false、12 分钟 timeout 和原 reader/cleanup 路径，只清空旧应用 SHA。MCP 四个支持文件原样。

## 下一次缓存阶段的固定分母

未来只有 root 在确认实际部署后，另行将 continuation control 显式改为 enabled=true、phase=cache-live、expectedSha=该实际应用SHA、cacheTurns=3，才授权一轮缓存验收。单改源码 pin、上传本稿或 disabled job 成功都不是生产授权。

固定 Haiku 三轮、Luna 三轮，最多六次用户发送；后四槽 H2/H3/L2/L3 是预先定义的 warm 槽，每槽客户端 send→firstText 目标不超过 3000ms。失败、未发送和未覆盖保留原槽，不补跑、不只挑命中或较快结果。一次模型首轮失败会停止该模型的后续轮次；另一个模型通过独立进程/会话继续运行，保持两份独立 continuation wrapper 为权威收据。

未来授权的 phase=cache-live 在原六条自然短答上附加三个独立 worker、原生 WebSocket/BroadcastChannel 与实际核心消费者；它调用同一个 runCacheTurns，不发送额外模型消息。observer 只代理正常 ticket/chat 读取，保留24次 chat 上限和有界关闭；没有定时 DB 轮询。现有一次返回响应延迟只改变该测试客户端的交付，真实新 revision 必须来自 socket，未覆盖即如实记录。新的 source/worker 离线证明不是新的生产通过，也不是 React/浏览器渲染证明。原六槽与 Stop 十槽失败分母不改变。

## 流、停止和证据

正常短回复以对应新 committed、持久化回复/cursor、权威 idle 收敛，再取消本 reader；持续 HTTP 的 EOF 不是回合成功前提。旧 prefix 不供新首字/新 committed 计数；真实 stream error、版本变化和 scope 不符仍失败。

普通 Stop 需本次 Stop ACK、同一新 committed、持久化 stopped 标记、idle，并核 live append/reset 最终正文与该 stream 新持久化正文一致。客户端读流关闭不等于 provider 物理停止。

工具没到真实边界仍是 failed/not_covered；自然无工具回复只有在严格持久化与 idle 确认后才省去多余 cleanup Stop。before/during 的分类仍须对应 server body/Stop/audit 区间，不凭 public running 或固定延迟宣布覆盖。

每个模型的 wrapper 保留真实发送、workflowRunId、所有失败和 cleanup；Actions step conclusion 不能代替内部 outcome。artifact 名仍为 issue-1506-alex-continue-<run_id>，包含 issue-1506-alex-report/*.json。Luna 早失败时不要用可能覆盖的 standalone 默认文件代替两份独立 wrapper。

服务端日志遵守既定最多 cache6+ordinaryStop2 共8个 exact-wrun 请求、每个一次 limit100；没有新增查询预算。rawCache 是 SDK 兼容 usage 边界，不是原 provider HTTP 字节；missing 不证明 provider 没返回。各独立时钟不跨钟相减，嵌套跨度不相加。

MCP 是独立、仍禁用的三 reader 阶段：latest、90s quiet、headers后5s abort；0模型、0业务写工具/聊天任务写入、0Stop、0MCP DELETE。正常 OAuth 创建/撤销会改变其授权记录，不能称所有 DB 零 mutation。未来实际执行需单独激活、服务器证据与授权清理，当前没有该通过证明。
