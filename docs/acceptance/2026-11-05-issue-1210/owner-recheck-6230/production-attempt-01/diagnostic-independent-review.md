# A43 diagnostic 补丁独立审阅

## 固定审阅对象与方法

- Source commit：`b1bee585e7f1c78b09fb8f80b8752227591b13f1`
- Tree：`6a28852f5862e2b22495c55843f41dd7028a4465`
- Root 已核对上述 tree 与本地 `git write-tree`、GitData 一致。本报告归档此前对本地两文件 diagnostic diff 的独立审阅结论，不新增源码重审。
- 审阅工作区：`/workspace/scratch/6b649311982a/Mikka-recheck-diagnostics`
- 变更文件：`lib/factory/http.ts`、`lib/factory/http-list.test.ts`。
- 审阅仅做源码和 diff 只读检查；未修改实现，未运行测试，未调用生产接口、浏览器、数据库或模型，未执行发布。

## 结论

未发现阻断项。补丁为 POST 请求捕获到的受控 `FactoryError` 增加现有结构化日志，保留原有权限检查、HTTP status/body 和 GET 行为。此结论是静态源码审阅结果，不代表测试已通过，也不证明 A43 的实际失败原因。

## 审阅事实

### 日志隐私与输出契约

`lib/factory/http.ts` 新增 `logCodedError` import，并在 `FactoryError` catch 中增加：

```ts
if (req.method === "POST") logCodedError(error, { taskId: req.taskId });
```

新增上下文只有此前已通过 UUID 校验的 `taskId`，没有请求 reason、userId、URL、binding、凭证或 provider response。

`packages/protocol/src/coded-error.ts:80–95` 的现有 logger 输出单行 JSON，字段包括 `level`、`msg`、`event`、`code`、可选 `detail`、`causes` 和传入的 `taskId`。`causeFields`（同文件 `:57–73`）限制 cause 遍历深度，按既有规则保留 name/code/detail，不输出 message、stack 或原始响应正文。该补丁未扩大 logger 的序列化字段。

`logCodedError` 内部已有 try/catch（同文件 `:92–95`），日志 sink 抛错不会替换原错误或改变原有受控响应。

### 权限、JSON 契约与非 UI 范围

日志调用位于现有 session、task UUID、POST Origin、body schema 检查以及 store 调用之后的 catch 内。补丁未更改任何权限守卫、所有权判断、action 分支、事务、dispatch 或 retry 行为。

现有响应映射保持不变：`factoryNotFound → 404`、`factoryInvalid → 422`、其他 `FactoryError → 409`，响应体仍为 `{ error: error.code }`。非 `FactoryError` 继续原样抛出。GET 不执行新增日志调用。

变更只涉及服务端 HTTP handler 和其测试，没有 UI、文案、翻译、路由 adapter 或产品流程变更。

### 测试的静态检查

新增测试检查以下行为，但本审阅者未执行测试：

- 一次受控 recheck 拒绝产生恰好一条日志。
- 409 响应 JSON 与既有契约完全一致。
- 日志保留受控 cause code/detail，排除请求 reason、provider error message 和请求 URL。
- `console.warn` 抛错时仍返回原有409响应。

## 覆盖边界

新增日志只覆盖进入 catch 的 POST `FactoryError`。前置显式返回的 `authRequired`、`originRejected` 和 schema 422 不会由该日志记录；未被封装为 `FactoryError` 的 `ComputerError`、`AgentProfileError`、`ActionFailureError` 等也不在此日志分支内。

因此，原始 `ComputerError` 自带的400/409不能直接当作本接口会返回的受控4xx。该补丁提供后续拒绝原因的诊断信息，不改变错误分类，也不能从既有 `checkRetryFailed` 文案反推出历史请求的实际 code。
