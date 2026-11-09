# #1512 受控故障的 PostHog 回读准备

状态：**仅准备，实际 trace ID 为 0，PostHog 查询为 0，backendObserved=false。**

本项核验已有受控故障路径：20 次 ordinary `GET /api/trace-benchmark`，真实 loopback PostgreSQL，产品 `RunSampler(0.1)`、`RetainingSpanProcessor`、`SafeExporter` / `SafeLogExporter`，资源标记 `environment=dev`、`service=mikka-web`、`service.version=精确 main SHA`。它是隔离测试环境故障的真实 OTLP 入库回读，不是生产编码任务或模型验收。

## 输入：只使用这次真实 runner 的原始收据

读取 workflow artifact 中的 `production-run-observability-report/controlled-failure.receipt.json`，保留原件及 SHA-256，并核对实际 workflow 的 main SHA。当前 runner 合同如下；执行时仍以对应 main 源码和真实文件为准。

| 收据字段 | 用途 |
| --- | --- |
| `kind=controlled_failure_otlp_probe`, `sourceRevision`, `environment=dev` | 绑定实际测试来源，不与 production 业务混合 |
| `startedAt`, `endedAt` | 固定 UTC 查询窗：开始向下取整秒，结束向下取整秒后加 1 秒；左闭右开 |
| `traceIds` | 必须为本次实际 20 个不同、非零、32 位小写十六进制 ID |
| `perTrace[].traceId/rootSpanId/pgSpanIds/errorSpanIds` | 本地已净化导出对象的实际 ID 映射，与后端逐项双向比较 |
| `configuredSampleRate`, `initialUnsampled`, `checks` | 保留已有采样/故障本地事实；不把配置 0.1 当实际尾保留证明 |
| `localRetainedRoots`, `localExportedSpans`, `localExportedLogs` | 对照实际数量；当前路径预期 20 根、80 spans、40 logs，未运行前不填作观测值 |
| `transport.spans`, `transport.logs` | 原始官方 OTLP exporter callback 的批次/记录计数；不代表 HTTP wire 次数或已存行数 |
| `backendObserved=false` | 原件保持不变；后端验证写独立回读收据 |

没有真实收据、实际 IDs 不足 20、来源无法绑定时，记录缺口；不得用旧 trace、全零 ID、示例 ID 或宽泛时间检索代填。

## 查询：四个固定模板

`controlled-failure-query-templates.safe.json` 包含 `span_counts`、`span_rows`、`log_counts`、`log_rows`。复用已验证的 `posthog.trace_spans` / `logs` 表、Base64 存储 ID ↔ hex 投影、UTC 时间、attributes/resource_attributes、稳定 UUID 排序和 500 行分页。

四个模板均固定 `dev + mikka-web + 精确 service.version + 实际 20 IDs + 同一 UTC 窗`。查询不预先过滤 ERROR、正确 cause、采样率或 retention，以免把不符合项藏掉。APM 与 Logs 均走已有 Logs 表路由；不猜 `connectionId` 或物理 cluster 参数。

这些是新组合的 dev 查询，**仅做本地来源和字段审查，未在后端编译或执行**。原 14 个生产模板及 hash 绑定的 normalizer/reconciler 完全不改；不能把新 SQL 交给旧 normalizer 后忽略其拒绝。

下面只做本地参数展开，不访问网络。三个参数依次为实际收据、模板文件、请求输出目录；不要现在用虚构收据执行它。

```bash
python3 - "$ACTUAL_RECEIPT" "$TEMPLATE_FILE" "$REQUEST_DIR" <<'PY'
import hashlib, json, re, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

receipt_path, template_path, output_path = map(Path, sys.argv[1:])
raw = receipt_path.read_bytes()
r = json.loads(raw)
t = json.loads(template_path.read_text())
assert r['kind'] == 'controlled_failure_otlp_probe' and r['environment'] == 'dev'
assert re.fullmatch(r'[0-9a-f]{40}', r['sourceRevision'])
ids = r['traceIds']
assert isinstance(ids, list) and len(ids) == len(set(ids)) == 20
assert all(isinstance(x, str) and re.fullmatch(r'[0-9a-f]{32}', x) and x != '0' * 32 for x in ids)
def utc(value):
    assert isinstance(value, str) and value.endswith('Z')
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
start, end = utc(r['startedAt']), utc(r['endedAt'])
assert start < end
bindings = {
    'source_revision': r['sourceRevision'],
    'window_start_utc': start.replace(microsecond=0).strftime('%Y-%m-%d %H:%M:%S'),
    'window_end_utc': (end.replace(microsecond=0) + timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M:%S'),
    'trace_id_b64_sql_list': ', '.join("base64Encode(unhex('" + x + "'))" for x in sorted(ids)),
    'row_offset': '0',
}
output_path.mkdir(parents=True, exist_ok=True)
for name, item in t['queries'].items():
    sql = item['sql']
    assert hashlib.sha256(sql.encode()).hexdigest() == item['sha256']
    for key, value in bindings.items():
        sql = sql.replace('{{' + key + '}}', value)
    assert '{{' not in sql and '}}' not in sql
    request = {'query': sql, 'truncate': False,
        'context': 'Issue1512 actual 20 controlled dev failures; exact receipt IDs/UTC/main version, metadata only; not production model evidence.'}
    (output_path / (name + '.offset-0.request.json')).write_text(json.dumps(request, indent=2) + '\n')
(output_path / 'scope.safe.json').write_text(json.dumps({
    'receiptSha256': hashlib.sha256(raw).hexdigest(), 'sourceRevision': r['sourceRevision'],
    'traceIds': sorted(ids), 'windowUTC': [bindings['window_start_utc'], bindings['window_end_utc']],
    'projectId': 670821, 'environment': 'dev', 'service': 'mikka-web', 'queriesExecuted': 0,
}, indent=2) + '\n')
PY
```

由 root 决定执行时间，通过现有官方 PostHog MCP `execute-sql` 读取这四个请求，不创建 insight/dashboard/notebook 或浏览器会话。保存每次精确请求、未改写原始响应、capture UTC 和 SHA-256。先取两个 summary，再取两个 detail；完毕后在相同 scope 重取 summary 对账。

## 分页和响应归一化

两份 detail 都从 `OFFSET 0` 开始。只有一页实际返回 500 行时才继续 `500, 1000, ...`；直到真实末页少于 500 行，满页不能被当作结束。scope、SQL 除 offset 外的字节和最终 `uuid` 排序保持不变。两个 summary 最多各 20 个 trace 分组；缺失的 trace 不会自动出现一条 0 行。

复用既有规范的做法：按模板的精确列名/顺序和类型读取，核对原请求 SQL，保留 null、raw boolean 编码和实际行数。若 MCP 返回 pipe 表，严格逐行逐列拆分，不能用摘要文本拼行；若 API 有列/数组结构，则保留其原始结构。显式 truncation、格式变化、缺列、截断标记或 SQL 错误均记录为未完成；`truncate:false` 是请求偏好，不冒充服务器的“未截断”声明。

分别对账物理行、存储 UUID、逻辑 span ID；不要将重复行去重后隐藏数量差。detail 与独立 summary 必须一致。已知实际 span ID 闭集也与 runner 的 `perTrace` 双向比较。若出现真实分页或采集中数量变动，沿用已有做法，再取同一 scope 的完整快照核对 ID 集合稳定；不得为了等待入库重新触发 20 次故障。数据尚未出现时，保留 missing/pending，由 root 决定有限次相同 scope 的后续回读。

## 每条 trace 的对账

1. **根与受控 cause：** 本次 `rootSpanId` 出现在 APM；`is_root_span=true`，`stage='GET /api/trace-benchmark'`，method GET，route `/api/trace-benchmark`，HTTP 500，`status_code=2`。`error_code='trace_acceptance_failed'`、`error_detail='controlled_database_failure'`，安全 `error_causes` 包含 PostgreSQL code `22012`。根 parent 的空值或全零值按真实响应保留，不编造父 span。
2. **实际尾保留：** 根为 ordinary (`critical_raw=false/0`)，所有本次本地树的 APM spans 均有 `sample_rate=1` 与 `retention='error_or_slow'`。缺失值仍为 unknown。`initialUnsampled` 是 runner 的既有本地收据，不从后端有效采样率倒推最初 head decision。
3. **真实 PG 子链：** 与 runner 的三个 `pgSpanIds` 完全对应；`db_system='postgresql'`、`db_operation='SELECT'`，三个 child 均指向本次根，且一个 PG span 为 ERROR。`errorSpanIds` 与后端 ERROR span 集合双向相等。只读 statement ID，不检索 SQL 文本、参数或数据库错误原文。
4. **关联 ERROR log：** 根须有同 trace ID、同 root span ID 的 ERROR log，safe body 为 `failed`，code/detail 一致；采样率与 retention 同 APM。PG ERROR log 也按真实 span ID 保留并核对。日志 body 仅返回固定类别，异常 body 返回 `unexpected_body_redacted`，不输出原文。
5. **范围与数量：** 实际 20 个输入 trace 与完整可验证的 trace 集合逐一对账；分别记录缺失 IDs、字段失败和物理重复。将后端实际 span/log 数量与 runner 的 `localExportedSpans/Logs` 比较；差异保留原因和未决项，不用预期 80/40 代替观测。

输出填入 `controlled-failure-reconciliation.template.safe.json`。`backendObserved` 只描述真正取得了后端数据；是否 20/20 都满足，由 `completeFailureTraceIds` 和具体 checks 独立表达，不能把“看到部分行”升级为全通过。原 runner 的 `backendObserved=false` 不覆盖。

最终结论限定为这次 dev 受控故障的后端保留与关联结果。不能把 API 200、exporter callback SUCCESS、InMemory 20/20 或本模板准备成功称为 PostHog 入库，也不能将本项扩写为全部生产验收完成。
