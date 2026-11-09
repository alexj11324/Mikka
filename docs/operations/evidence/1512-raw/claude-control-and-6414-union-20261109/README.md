# #1512 CP39 — Claude 官方控制、6414 正常合流与新 R7 边界

**生产验收仍为 0/2，issue OPEN。** 本 checkpoint 固定真实源码与已核控制事实；当前 Native/strict 还在正常执行，完整 CI 不提前判定通过。

## 已实际完成

17:22:28 UTC 正常 CAS 一次更新自有 feature 到6414a08ddb4a92962bc82e9e427c391d645cacb2 / tree05b40c13c233d7f3cef989011705cf624b27c507。先以普通 merge 7a775984合入实际main5ba（原owner已落地1834），再以普通 merge 6414合入共享1835固定37fb。完整6805 leaves远端核对0差异，仅6已有blob改变，另外6799不变。main/生产账号未动。

实际CI42663994959/A1 checkout576c903c/tree05b40，与head整树相同；当前Core57 targets/driver74逐名PASS、Source361、Integration29、PR E2B官方文件34项及其他回归已通过。原6cc的Native数字不移作6414通过。

官方Claude控制42661569263/A1原Git包868d0b…已独立核验。Root按原JSON文本切出claude/summary两member，只移除wrapper缩进；10322B/SHA1e53…、1273B/SHAadbc…与原artifact完全吻合，所有大整数原lexeme保留，没有用JavaScript浮点重序列化冒充原件。4阶段12节点/8链、0777及0:0、精确两条fresh链接、当次root文件及双cleanup全部一致。只创建过原owner的1模板/1VM，无Mikka/CLI/model；本方没有第二次控制或原ZIP/log下载。官方base/build/envd身份未采，保持unknown。

## 共享修复与后续源码

37fb的原320规则/matcher完整保留，仅增加2个Claude条目；原29测试方法保留，维护1个与新事实互斥的旧参数，新增5方法。Git原件RED→GREEN已独立审阅：旧策略2个正例ERROR；6个子项FAIL是更早拒绝码不同，不是旧策略放过坏终点；候选34/34无skip。原测试其余字节可严格恢复。

1835最新8197在上述基础上补原证据、ADR和supplementalControls指针；真正授权规则不变。但完整policy bytes参加policySha256和canonical worker recipe，因此**该元数据变化仍会改变哈希**。worker-inputs-at-37fb文件仅证明当时固定37fb的480项输入等同，不冒称对8197仍字节相同。当前Native自然完成，不因这份证据补充机械取消或重跑。1835必须由其原owner先正常落地。

## 5ba 新 R7 失败仍未解决

自动R7 42661874195/A1于17:23:13 FAILURE，三个本run候选已由原owner精确清理，subs/await-web/publish跳过。本次公开实际差异是Codex rootCA0644→0777，以及Desktop apt.extended_states.0 SHA变化；具体failure phase与未打印的完整stat尚unknown。原log/ZIP仍由原owner唯一读取，本方请求已有安全投影。

源级审查覆盖active五个run_cmd、strict→ready→fresh、414锁定依赖snapshot与允许的esbuild安装钩子、Desktop pip及startup路径。没有找到明确Mikka源码直接写这两路径；缺少第三方wheel/钩子实际原件，**不能排除Mikka或证明provider已免责**。固定E2B/APT源码仅给出候选机制，本次部署版本、timer和writer仍未证明。不会据此放宽规则。

#1505 owner已接手唯一Codex/Desktop有限官方控制。本方停止重复准备，无新controller/ref/VM。自然前提缺失或未复现就记录边界；不人为chmod、运行apt/savelog或改timer制造前提。

## 归档

13 payload /135016 B，逐文件bytes/SHA/Git blob见index。source-only早期回执中的pending/conditional是其冻结时状态；后来原件核验在单独root proof中补齐，不改写历史。CP38的6cc原门禁完整保留。所有control/R7分析都不替代#1512两条真实生产调用链、Logs/AI/Replay/原生PNG与最终清理。
