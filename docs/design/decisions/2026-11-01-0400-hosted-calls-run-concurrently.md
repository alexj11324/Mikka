# Hosted model calls run concurrently

- Date: 2026-11-01
- Source: Alex: 「为什么一次只允许一个模型调用啊？这个是有问题的吧？应该是允许并发的呀」
- Rule: —
- Replaces: the "one pending/unknown call per workspace" concurrency limit kept
  by the 2026-10-31 `decisions.md` row on hosted-call admission. The rest of
  that row stands: a lone call needs only a positive balance and is charged its
  actual cost afterwards.

A workspace's Coordinator, bots and threads may call Mikka 默认 at the same
time. Admission works like a card authorisation with a concurrency cap:

- Each in-flight call holds an estimated maximum cost,
  `HOSTED_CALL_HOLD_MICRO_USD` (USD 0.10: the 4,096-token output cap at USD 15
  per million plus about 100k input tokens). The hold is not charged; it only
  decides whether another concurrent call fits.
- A call is admitted when nothing else is in flight and the balance is
  positive, or when balance − holds of calls in flight ≥ its own hold.
  Otherwise the existing `free_allowance_used` refusal applies.
- At most `HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE` (8) calls run at once per
  workspace; the ninth gets `usage_concurrency_limit`.
- Settlement is unchanged: the actual receipt is charged, the hold ends with
  the call, and an overrun stays debt. An unknown receipt keeps its hold (not
  its slot) until reconciled or released after 10 minutes.
- `usage_in_progress` now means only a replayed call ID; a paid provider call
  is never replayed. The daily platform budget and other abuse limits are
  unchanged.
