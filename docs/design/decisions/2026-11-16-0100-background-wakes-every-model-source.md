# 后台唤醒对所有模型来源一视同仁

2026-11-15：Alex 决定，派出去的任务回报、定时任务这类后台事件到了，对话就自己起来处理，不管它用的是 Mikka 额度、自己的 Key（BYOK）还是订阅。延续 [2026-11-15-1900](2026-11-15-1900-models-on-gateway-like-capy.md)。

## 决定

- 对话选的是 Mikka 额度的模型时，后台事件同样唤醒它，和订阅、Key 一样。
- 不唤醒的只有已知用不了的情况：这台服务器不再提供这个模型，或者 Mikka Cloud 上额度用完且没有设好的替补。这和订阅额度用尽时的处理一致。
- 事件不会丢：没唤醒的事件留在收件箱里，等能用的模型出现后再处理。

实现：`lib/coordinator/model-ready.ts`（`botModelReady`），测试在 `lib/coordinator/model-ready.test.ts`。
