# Coordinator 后续验收：禁用准备稿（first-text-next V1）

本稿是基于 e6f84d617581ade6ddb247176c34048cab749c04 禁用验收树的增量适配，保留既有 driver 修正和最新 Node.js/PostgreSQL 工具提示词，不回灌历史 checkpoint。
本稿没有执行生产登录、模型、SQL、部署或控制激活，也不构成新的生产通过证明。

## 源码与禁用边界

应用源码输入：06173adb3fa75a4b7bfd9274efd873823f06d0ea，tree：cca2792838d3ba0ea4fedb049e798a469b8cb833。
这只是不可变 Git 源码绑定；真实 production alias、READY、公开版本及发布配置需由执行者另行核实。

十二个来源 pin 均按实际应用 Git blob 校验：原十项，加上实际 read-observer 运行时依赖和 components/swr-defaults.tsx 接线来源。保留原已审十二维内容，仅将 channel 更新到 #1665 / afae721f6730434ded6be932a7f9dd585c22ee49 的每 kind watermark；a23b2e0b48dc5cb2dac8bb9ecde734a03537339e 与 f14fc28c199be3c8c85ad26a77ef65222e92bfea 的十二项逐字相同。未知漂移仍拒绝。decoder 固定 490572a956f7675c1305f15394d75e1f6634cf3440da17fb3376dfb5189cf4e4。加载器只将相对导入解析到已固定的运行时模块，拒绝未列目标、外部包和越界路径。Hook、Coordinator 组件和 SWR defaults 仅核来源，不在 Node 渲染 React。

本版明确只输出四条路径：live-source.mjs、issue-1506-alex-continue.yml、LIVE-ACCEPTANCE.md、live-consumer.test.mjs。当前 worker/offline-worker 与最新四个 Stop driver/test 原字节保护，未改其运行时接口。worker 使用实际源码 readBoundary/readFresh/observeSWRRead/acceptSWRRead/failSWRRead，读取正常 RPC 快照后才接受并提交同一对象；保留 owner/namespace、required+held+local revision、local-write identity 与关闭守卫。离线平台夹具的 fixture-read 命令只在测试模块中，生产 worker 不接收该命令。没有复制或改写产品算法。

继续使用原 ACME 自有工作区与 Haiku/Luna retained fixture receipt，不重建、不重新选模型。普通停止/工具未覆盖修正来自独立恢复 checkpoint 344fafb353d1128f89475bc827a404eff4520451，其四文件已单独离线 RED→14/14 GREEN；本稿没有新增生产 Stop 成绩。

continue.json 完全保留 e6 原件：enabled=false、phase=cache-live、expectedSha=null、cacheTurns=3、liveTabs=3、delayOneReturnedResult=true。continuation workflow 的 MIKKA_STOP_CASE 仍是 during_tool。
presence workflow 保持原 literal false 和空应用 SHA；legacy resume workflow/control 原样，不给没有 enabled 字段的旧控制文件添加或修改字段。
MCP workflow 原字节保留：literal false、空应用 SHA、12 分钟 timeout 和原 reader/cleanup 路径不变。MCP 四个支持文件原样。

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

## 本次源码兼容边界

连接 readiness 建立连续覆盖起点；后续 push 只推进其 kind 的 watermark。未发生 bot_chat 失效的已接受读取可供晚订阅复用；bot_chat 自己的新事件、断线重连或连接前读取仍要求新读。新增离线回归使用实际编译的 LiveChannel/read-observer，不改产品算法；原三独立 worker、旧响应跨新 revision 的拒绝、same-realm 在途读与 socket/error 清理断言保留。模板 LIVE_SOURCE_COMMIT=null 默认拒绝运行；未来实际合并/稳定部署的完整 SHA/tree 必须由 root 核对后显式传入。a23/afae/f14 的离线证据不代表它们已用于新生产验收。
