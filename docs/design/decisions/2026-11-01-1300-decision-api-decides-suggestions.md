# The Decisions API decides suggestions and approvals, with no rule set in front

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「只要涉及到权限请求或建议的内容，全部走 Decision API，不允许在前面用 rule set 过滤一次。能够使用 Decision API 的地方，绝对不允许使用规则集，必须通过 Decision API 来决定。」 and 「建议是什么？就是读了我所有的信息，然后给我提供下一步的建议。重要的才是建议，而且这也需要走 Decision API 来决定。」
- Rule: R-20
- Replaces: the `ruleLevel` / `fallbackLevel` steps of the attention model (R-20 in `../decisions.md`) and the bot-comment filter added in #768

Whether something asks the person for permission or approval, whether a
connected app's event becomes a suggestion, how important it is, and whether
the person is interrupted are answered by the existing Decisions route
(`lib/coordinator/decide.ts`). No rule, regex, allow/deny list or
`if` on the event runs before that call to drop or rank it, and none stands in
for it when it gives no answer.

What follows for suggestions:

- Every notification is judged: the person's own actions, bot and no-reply
  senders, Gmail promotions and comments with no readable text included. The
  facts that used to be rules (`automated`, `byThePerson`, Gmail's category)
  are evidence in the model's input.
- No answer (key missing, provider down, refusal, malformed) stores nothing
  and shows nothing; the next delivery or the hourly backfill asks again.
- Security floors are not rule sets and stay in code: authentication,
  webhook signatures, tenant and recipient matching (whose event it is), the
  person's own source switches in Settings, and cost budgets.

What follows for importance and handoff:

- The level is the model's choice. The code floors (any cost at least high,
  48 hours or irreversible within a week critical), the ten-minute
  verification-code cutoff, the 0.5 confidence downgrade of routed levels and
  the "a later notice never rates below its matter" rule are gone; the floors
  are guidance in the level question.
- Whether a matter goes to the Coordinator, the first time or again after a
  decision, is the model's `handOver` predicate, not a list of routed levels
  or a level that went up.

What follows for interrupting the person (Alex, 2026-11-01: 「这个东西很便宜，全部交给 Decision API 来处理」):

- The notification budget (5 a day, 30 minutes apart, critical skips the
  spacing) and the 12-a-day handoff budget are gone. Before the Coordinator's
  `notify` is recorded, the Decisions API decides whether to interrupt now,
  reading how often the person was told today and how long ago; a no returns
  `notifyDeclined` with the time to look again. No answer leaves the
  Coordinator's call standing, logged as a fallback. A reminder the person
  asked for is not asked about.
- Which waiting matter the Coordinator takes up next is the Decisions API's
  pick (or none), not level order. No answer hands nothing; the next wake asks.
- A matter the Coordinator left undecided (after its turn, or 30 minutes in
  hand) is settled quiet or snoozed by the Decisions API, not by "critical or
  high snoozes, the rest go quiet". No answer snoozes it to be asked again.
- Runaway caps stay in code: 24 tellings and 48 handoffs in 24 hours.
