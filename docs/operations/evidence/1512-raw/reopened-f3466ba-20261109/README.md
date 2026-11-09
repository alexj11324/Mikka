# CP33：重新打开后的 f346 完整 CI 与原始 Native

记录时间：2026-11-09 13:44:39 UTC。关联 #1512 / PR #1799。此检查点证明本轮代码与 Native 门禁；**生产 ACME 验收仍为 0，issue 保持 open。**

## 版本与事件

P0 PR #1636 已正常合并为 `111a8dfb8b227ac0441324339ff42e4328ea609a`，tree `6a06f3742fb0dfc35bed19780fe09da2747c1ddc`。Git commit 时间12:57:16Z与PR merged_at12:57:17Z分别保留。CP32的条件树被实际对象验证。

历史commit923cb5的标题包含关闭关键词，随P0入main将未合并的1799自动关闭。Root13:01:28Z恢复open；source/ref没变。reopened事件自然触发本轮CI，未手工重跑。

候选head仍 `f3466ba479ef51918790f521a288feaef5160e44`。Changes原日志和Native原件实际checkout均 `3b51cf11dffdbb3a6167946a18e7302f3cb6035b`，parents=[111a8df,f346]，tree仍 `102bc671b4c5e3cf49fcce54025c71b26f817cf2`。直接两树差57路径，与GitHub merge-base显示68分开记录。

## 完整门禁

CI42621847483/1于13:34:16Z观察SUCCESS。本次14workflow全部SUCCESS；主CI22job=21SUCCESS+原OIDC SKIP。全部Actions50job=39SUCCESS+11原条件SKIP；加本次GitGuardian后head51checks=40SUCCESS+11SKIP。Root逐ID/status/conclusion/URL/suite对齐50job/check，错误0。

GitHub latest检查API实际仍返回101条，已分页100+1并按本次14suite排除旧50条Actions。旧叶测试数值没有作为本轮执行数。Production build and browser interactions等聚合作业名不被改写成实际生产浏览器验收。

本轮changes完整selection为389272B，SHA256 `e1305a79e9240dc4e1c1dca2b997fbea4bf31ef8d520d676c837e7167baed178`，与前轮f346逐字相同：full=true、86unit tasks（57Core+29Integration）、72DB suites、原4分片。原f9a889 blob复用，不再上传另一份selection。

## 本轮原始 Native

| 计量窗口 | Native | Web / hosted |
| --- | ---: | ---: |
| 完整登录 | 431=21+15+395 | 444=19+0+425 |
| 原第一对启动 | 211 | 228 |

完整邮件认证、PKCE、自动导航、工作区选择及并发后台均保留，未移动窗口、减数或选择第二对。Root独算24记录、12checkpoints、8段、2280分桶值、1314ordinal，错误0；公开V8复算代码复用前轮已核版本。原协议字节也保留在原件和Root收据中；它们只覆盖主API进程的PostgreSQL协议，不是全网传输字节。

四窗所记录RPC的crossesStart/crossesEnd/completionNotObserved/completionWithoutStart均0。物理/逻辑started=completed分别为Native16/40、Web36/36、首Native9/19、hosted19/19。diagnostics仍incomplete；unknown context/statement分别91/130、87/138、48/76、48/76，overflow/dropped0。不能把unknownReadings=0当细粒度归因完整。

本轮实际daemon为 **0.0.562 / 111a8df**、protocol3；bundled/hosted一致。与前轮facb/0.0.551分开绑定。bundled ready7282ms/23reads、hosted已在线环境35ms/1read，后者不是新安装用时。5对cold median为3757.55/3814.39ms，不替代原FIRST pair的SQL门槛。

100parity行（50screen×2theme）全部通过；threshold0.001、color0、56行原avatars/timestamps mask不变；129600000比较像素、143变化、最大比率0.00003935185185185185。Root核数但未查看这些parity PNG像素。Crypto3个独立进程、同一不可变package、keychain failure0；Root另外核crypto.package与原独立package逐字对象相同。

清理字段分列：lifecycle restored=false/unchanged，owner及peer before=false→after=true；smoke restored=false/unchanged，before=true→after=true；parity restored=true。没有把false改写成true。

## 原件与资源

Native唯一reader取得终态job原log一次、两个ZIP各一次。两个artifact为13678393148与13678099233；5份原JSON逐字归档，完整310文件hash索引保留。22 Native payload共1334469B；其index另计14324B。Root直接读取并核5原JSON、terminal和VM清理收据，其他对象按索引声明remoteConfirmed保留，不扩大独立读取范围。

恢复VM `sbx_tXmjfrmsfsXDua4JK2tSNLgsCY23` 实际13:35:00.203–13:40:07.741Z，duration307538ms、active CPU7530ms；ingress14943740B、egress402061B。已stop/delete，并以同name/project/team、resume=false精确GET404 not_found确认。未延时，当前本方活动资源0；美元费用unknown。

## 官方费用补充

复用11:47–11:49冻结账单，不新增billing/SQL。公开Logs/Tracing合并计量与AI/Replay/Vision分档公式单独归档。Root读回本次已有MCP docs-search原返回并核hash，确认所有$ai_事件按AI Observability计费，不再按Product Analytics重复计费。Vision按成功observation的固定模型credits计量，不能将扫描请求或快照分块直接当新录屏。公开列表费率是估算条件，组织USD=null仍unknown；当前免费计划不能被改写成自动购买超额用量。

## 继续完成

源门禁已齐；实际P0窗口、主线部署与资源交接仍按真实状态处理。随后由本issue owner正常merge，验证实际生产版本，分别执行ACME Personal的官方Haiku5.5与GPT-6 Luna案例，再核完整APM/AI/Logs/Replay/Notebook、实际PostHog PNG像素、最终源受控失败与开销以及本方清理。没有以本检查点替代这些生产标准。
