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
