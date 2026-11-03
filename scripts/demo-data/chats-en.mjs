// English bot chats for scripts/demo-data/seed.mjs (--content en). Same shape
// as chats.mjs: one AI SDK model message per coordinator_messages row of that bot.
// Placeholders the seed replaces: {{issue:<key>}}, {{run:<key>}}, {{bot:<key>}}, {{artifact:<key>}}.

const user = content => ({ role: 'user', content })
const bot = content => ({ role: 'assistant', content: [{ type: 'text', text: content }] })
/**
 * An assistant turn that used tools, followed by the tool row with every call's
 * result, so each step reads as finished rather than still running.
 */
const botWithTools = (text, tools, results = {}) => [
  { role: 'assistant', content: [...tools.map(toolName => ({ type: 'tool-call', toolCallId: `call_${toolName}`, toolName, input: {} })), { type: 'text', text }] },
  { role: 'tool', content: tools.map(toolName => ({ type: 'tool-result', toolCallId: `call_${toolName}`, toolName, output: { type: 'json', value: results[toolName] ?? { ok: true } } })) },
]

// A 1×1 PNG: the chat shows an image count on the user's message.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export const CHATS = {
  coordinator: [
    user('Morning. What needs me today?'),
    bot(`root = Stack([intro, list])
intro = TextContent("Four threads are waiting on you, and v2.4 still has two blockers for Friday.")
list = BeTodoList("Today", [{id: "1", title: "Decide how the iOS 16 crash fix moves the Keychain read", status: "pending", detail: "iOS bot is waiting"}, {id: "2", title: "Pick msw or a two-test patch for the axios bump", status: "pending", detail: "Frontend is waiting"}, {id: "3", title: "Review #216, the Stripe webhook fix", status: "in-progress", detail: "Blocks Friday's release"}, {id: "4", title: "Approve tonight's index migration", status: "pending", detail: "10 PM window"}])`),
    user('What happened overnight?'),
    ...botWithTools('Quiet night overall:\n\n- **Sentry**: the `amount` TypeError on Bill Details is still the top error. Marcus owns the fix ({{issue:i-sentry-spike}}).\n- **Support**: 14 new tickets, mostly garbled CSV exports. Support is answering them with the canned reply.\n- **Billing**: Backend On-call has replayed 112 of the 186 failed `invoice.paid` events, with no double charges.\n\nNothing is down.', ['list_runs', 'list_issues']),
    user('Is v2.4 still on track for Friday?'),
    bot('Yes, if #216 merges today. Release Manager has the checklist in the v2.4 release group, and web ships first with iOS following next week. I\'ll flag it here if anything slips.'),
  ],
  frontend: [
    user('A customer says the sign-in page is blank on their Mac. Can you look into {{issue:i-safari-blank}}?'),
    ...botWithTools('I can reproduce it on Safari 17.0–17.3; Chrome is fine. The console shows:\n\n```text\nSyntaxError: Invalid regular expression: invalid group specifier name\n```\n\nThat\'s a lookbehind regex, which Safari didn\'t support before 17.4. The only dependency bump in v2.3.2 was `date-fns-tz` from 3.0 to 3.1, so that\'s the likely culprit. I\'m starting a thread to write a WebKit spec that reproduces it.', ['get_issue', 'dispatch_run'], { dispatch_run: { runId: '{{run:r-safari}}' } }),
    user([{ type: 'text', text: 'Here\'s the screenshot the customer sent' }, { type: 'file', mediaType: 'image/png', data: PIXEL }]),
    bot('Matches what I see. The thread failed because WebKit didn\'t install in CI, but I\'ve confirmed the root cause and written it up: [[artifact:{{artifact:a-safari-rca}}]]\n\nLet\'s ship a hotfix first and pin `date-fns-tz` back to 3.0.1.\n\n```diff\n-    "date-fns-tz": "^3.1.0",\n+    "date-fns-tz": "3.0.1",\n```'),
    user('Where are this week\'s frontend PRs at?'),
    bot(`root = Stack([title, table])
title = TextContent("ledger-web PRs this week", "large-heavy")
table = BeTable(["PR", "Title", "Author", "Status"], [["#488", "Drop barrel imports in components/ui", "Frontend", "CI running"], ["#485", "Add a UTF-8 BOM to CSV exports", "Frontend", "Needs review"], ["#479", "Fix privacy policy link 404", "Emily Rivera", "Merged"], ["#471", "Preload hero image, subset fonts", "Frontend", "Merged"]])`),
    user('What did #485 change?'),
    bot(`root = Stack([intro, diff, note])
intro = InlineText(["Fixes ", TaskChip("{{issue:i-csv-garbled}}"), ": without a BOM, Excel on Windows reads a CSV as Windows-1252. See ", SourceChip("https://github.com/acme-inc/ledger-web/pull/485", "PR #485"), "."])
diff = BeFileDiff("lib/export/csv.ts", "-  return rows.map(toLine).join('\\\\n')\\n+  return '\\\\uFEFF' + rows.map(toLine).join('\\\\r\\\\n')", "tsx")
note = BeAlert("Line endings changed too", "Excel handles CRLF better; Numbers and Google Sheets aren't affected.", "info")`),
    user('Great, I\'ll review #485 this afternoon'),
    bot('Sounds good. Once it\'s merged I\'ll check it again on staging with Excel for Windows.'),
  ],

  backend: [
    user('Stripe renewals haven\'t been recorded since yesterday. What happened?'),
    ...botWithTools('Found it: since 2:20 PM yesterday every `invoice.paid` webhook has returned 400.\n\n```text\nStripeSignatureVerificationError: No signatures found matching the expected signature for payload.\n```\n\nAfter yesterday\'s gateway upgrade, the body gets parsed to JSON before it reaches us. Re-serializing it changes the key order, so the signature no longer matches. Jordan already has a PR up that verifies against the raw body.', ['github_tools', 'github_call']),
    user('How many customers are affected, and how do we catch up on the ones we missed?'),
    bot(`root = Stack([stats, chart, steps])
stats = Stack([BeStat("Failed events", 186), BeStat("Customers", 171), BeStat("Unrecorded revenue", 7840, "USD", 0)], "row")
chart = BarChart(["2 PM", "4 PM", "6 PM", "8 PM", "10 PM"], [{name: "invoice.paid 400s", values: [12, 41, 47, 52, 34]}])
steps = Steps([StepsItem("Merge #216", "Verify webhooks against the raw body"), StepsItem("Replay", "Replay the 186 failed events from Stripe's event log (#218)"), StepsItem("Reconcile", "Compare subscription end dates between Stripe and the ledger")])`),
    user('Cartwheel Commerce is complaining about 429s on the public API again'),
    bot(`root = Stack([tabs])
tabs = BeTabs([{title: "What's happening", children: [TextContent("Cartwheel Commerce imports about 300 orders a minute, and the limit is 60 requests per token per minute.")]}, {title: "Logs", children: [BeCodeBlock("2026-10-31T09:12:03Z 429 POST /v1/orders token=tk_cart… limit=60/min\\n2026-10-31T09:12:03Z 429 POST /v1/orders token=tk_cart… limit=60/min\\n2026-10-31T09:12:04Z 429 POST /v1/orders token=tk_cart… limit=60/min", "text", "gateway.log", [1])]}, {title: "Options", children: [BeTodoList("Proposal", [{id: "a", title: "Separate limit for bulk endpoints: 600/min", status: "in-progress"}, {id: "b", title: "Add POST /v1/orders:batch, 100 per call", status: "pending"}, {id: "c", title: "Return Retry-After with every 429", status: "pending"}], "suggestion")]}])`),
    user('Do a and c first'),
    bot('Will do. PR #214 switches to per-route limits first and returns `Retry-After` on 429s. `orders:batch` moves to next sprint.'),
  ],

  ops: [
    user('The monthly report has been really slow the last couple of days, customers are complaining in Slack'),
    ...botWithTools('p95 for `/api/reports/monthly` went from 1.2s to 8s. From the slow query log:\n\n```sql\nSELECT date_trunc(\'day\', created_at), sum(amount)\nFROM transactions\nWHERE account_id = $1 AND created_at >= $2 AND created_at < $3\nGROUP BY 1;\n-- Seq Scan on transactions  (rows=2104331)  7612 ms\n```\n\n`transactions` has no composite index on `(account_id, created_at)`. The table passed 2 million rows last week, and that\'s when the full scans started. A thread is already adding the index on staging to compare: {{run:r-slow-report}}', ['list_runs', 'get_run']),
    bot(`root = Stack([line, collapse])
line = LineChart(["10/25", "10/26", "10/27", "10/28", "10/29", "10/30", "10/31"], [{name: "p95 (s)", values: [1.2, 1.3, 1.8, 3.4, 5.9, 7.6, 8.1]}], "s")
collapse = BeCollapsible("Slowest 4 queries", [BeTable(["Query", "Calls/hour", "Avg time"], [["monthly report aggregate", "1,240", "7.6s"], ["invoice list by account", "3,980", "820ms"], ["export csv", "96", "2.1s"], ["dashboard summary", "8,410", "140ms"]])], false)`),
    user('How do we add the index? Will it lock the table?'),
    bot(`root = Stack([tree, diff, approve])
tree = BeFileTree(["db/migrations/20261031_transactions_account_created_idx.sql", "src/reports/monthly.ts", "test/reports/monthly.test.ts"])
diff = BeFileDiff("db/migrations/20261031_transactions_account_created_idx.sql", "+CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_account_created_idx\\n+  ON transactions (account_id, created_at);", "diff")
approve = BeApproval("Run it in production at 10 PM tonight?", "CONCURRENTLY doesn't block writes and should take about 6 minutes. On staging, p95 dropped to 0.9s.", "acme-inc/ledger-api#217")`),
    user('What about the amount error in Sentry last night?'),
    bot('It\'s all coming from new accounts with no transactions: `TypeError: Cannot read properties of undefined (reading \'amount\')`, 200+ an hour since 9 PM last night. The Bill Details page reads `transactions[0].amount` without checking.\n\nI filed {{issue:i-sentry-spike}} and assigned it to Marcus. The fix is a one-liner: show the empty state when the list is empty.'),
  ],

  data: [
    user('Are the October numbers in?'),
    bot(`root = Stack([alert, donut, radial, list])
alert = BeAlert("Paid conversion is down", "Trial-to-paid was 11.2% in October, 2.4 points below September. Most of the drop landed on the two days of the blank Safari page.", "warning")
donut = DonutChart([{name: "Starter", value: 412}, {name: "Pro", value: 238}, {name: "Team", value: 61}], "accounts", "Paying customers")
radial = RadialChart("October MRR goal", 46500, 50000, "USD")
list = BeTodoList("Suggested follow-ups", [{id: "1", title: "Send a make-good email to trials lost during the Safari outage", status: "pending", detail: "About 140 people"}, {id: "2", title: "A/B test the Pro pricing page", status: "in-progress", progress: 60}, {id: "3", title: "Annual discount for the Team plan", status: "cancelled"}])`),
    user('Which features get used the most?'),
    bot(`root = Stack([area, card])
area = AreaChart(["Week 41", "Week 42", "Week 43", "Week 44"], [{name: "Transactions", values: [52100, 53800, 55200, 54900]}, {name: "Invoices", values: [8200, 8900, 9600, 11800]}, {name: "Report exports", values: [3100, 3300, 3500, 3700]}])
card = BeCard("What stands out", [TextContent("Invoices are growing fastest, up 23% week over week in week 44, right when invoice templates started rolling out. Report exports are flat."), Separator(), Stack([Tag("Invoice templates", null, "sm", "success"), Tag("Watch: slow report exports", null, "sm", "warning")], "row")], "Weekly, from product analytics")`),
    user('Pull the list of customers who got charged twice'),
    bot('In October, **3 customers** were charged twice because of the Stripe webhook replay: Bluebird Coffee, Northshore Florals and Little Oak Bakery, $147 in total. The refunds are ready; once you confirm, Support will email them.'),
  ],

  release: [
    user('Can v2.4 go out Friday?'),
    bot(`root = Stack([intro, questions])
intro = TextContent("Two blockers and one open question left. I need a few calls from you first.")
questions = BeQuestions("v2.4 release", [{id: "ios", title: "The iOS 16 cold-launch crash isn't fixed yet. Should iOS wait?", options: [{value: "wait", label: "Wait and ship together", description: "Could slip to next Tuesday"}, {value: "web-first", label: "Web first, iOS next week"}]}, {id: "channels", title: "Release channels", options: [{value: "web", label: "Web"}, {value: "ios", label: "App Store"}, {value: "android", label: "Google Play"}], multiple: true}, {id: "rollout", title: "iOS phased release on day one", input: "slider", range: {min: 5, max: 100, step: 5, unit: "%"}}, {id: "notes", title: "Anything to add to the release notes", allowCustom: true}])`),
    user('Web first, iOS next week. 20% phased release.'),
    bot(`root = Stack([timeline, form])
timeline = Steps([StepsItem("Wednesday", "Freeze main, tag v2.4.0-rc.1"), StepsItem("Thursday", "Staging regression and migration dry run"), StepsItem("Friday 10 AM", "Ship web; run the migration off-peak"), StepsItem("Next Monday", "Check Sentry and ticket volume, then pick the iOS date")])
form = Form("release-checklist", Buttons([Button("Confirm checklist", Action([@ToAssistant("Confirm the v2.4 release checklist")]), "primary")]), [FormControl("Release checklist", EditableTable("checklist", [{type: "text", key: "item", header: "Item"}, {type: "text", key: "owner", header: "Owner"}], [{id: "1", values: ["Multi-currency migration rehearsed on a production snapshot", "Jordan Lee"]}, {id: "2", values: ["Stripe webhook fix is live", "Jordan Lee"]}, {id: "3", values: ["Rollback plan and feature flag", "Alex"]}]))])`),
    user('Draft the release notes'),
    bot('Here\'s the draft. You can edit it right in place: [[artifact:{{artifact:a-release-notes}}]]\n\nHighlights:\n\n- Multi-currency accounts\n- Invoice templates\n- iOS home screen widget (ships with the iOS release next week)\n- Fixes for garbled CSV exports and PayPal payment status'),
  ],

  ios: [
    user('Where\'s the iOS 16 crash thread at?'),
    bot(`root = Stack([computer, note])
computer = ComputerCard("{{bot:ios}}", "{{run:r-ios-crash}}", "Cold-launch 10 times on the iOS 16.4 simulator and capture the crash logs.", "approval", "iOS", "iOS 16 cold-launch crash")
note = InlineText(["Thread ", RunChip("{{run:r-ios-crash}}"), " is waiting on you: should the Keychain read move after didFinishLaunching?"])`),
    user('Move it, but read the session token first'),
    bot('Got it: the session token is read synchronously in `application(_:didFinishLaunchingWithOptions:)`, and the rest of the preferences load after the first frame. I passed that on to the thread.\n\n```swift\n// AppDelegate.swift\nfunc application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: ...) -> Bool {\n    Session.shared.restoreToken()          // only this one\n    DispatchQueue.main.async { Preferences.shared.load() }\n    return true\n}\n```'),
    user('Which devices should the regression pass cover?'),
    bot(`root = Stack([grid])
grid = BeCardGrid([BeImageCard("iPhone 13", "iPhone 13", "Our main device, iOS 17.6.", ["Baseline"]), BeImageCard("iPhone SE", "iPhone SE 2020", "iOS 16.7, the device that crashed.", ["iOS 16", "Small screen"]), BeImageCard("iPad Air", "iPad Air 2020", "Checks split view and the widget.", ["Tablet"])])`),
    user('Ryan has the iPhone SE. Have him test it first thing tomorrow.'),
    bot('Done. I tagged Ryan Brooks in the thread; results by 10 AM tomorrow.'),
  ],

  support: [
    user('Bluebird Coffee says they were charged twice for their subscription this month. Can you draft a reply?'),
    bot(`root = BeResponse([TextContent("Here's a draft:"), BeCard("To Dana at Bluebird Coffee", [TextContent("Hi Dana, I'm really sorry about this. On October 30 our payment webhook had an outage, and while we recovered, your Pro plan was charged a second time ($49)."), TextContent("We've issued a full refund, which should be back on your card in 3–5 business days. We've also added a free month of Pro to your account for the trouble."), TextContent("If you have any questions, just reply to this email. — Olivia Grant, Acme Ledger Support")], "Ready to send as is, or edit first"), BeCitations([{title: "Stripe refund re_3Q8…", url: "https://dashboard.stripe.com/test/refunds"}, {title: "Incident: Stripe webhook signature failures", url: "https://status.acmeinc.example/incidents/2026-10-30"}])])`),
    user('What are customers asking about most lately?'),
    bot(`root = Stack([icon, table])
icon = AgentIcon("source", "142 tickets in the last 7 days")
table = BeTable(["Issue", "Tickets", "Suggested reply"], [["Garbled CSV export", "38", "Fix ships next release; open in Google Sheets for now"], ["Blank sign-in page on Mac", "27", "Fixed; refresh or clear the cache"], ["Double charge", "3", "Refunded, plus a free month"], ["How to send an invoice", "21", "Settings › Invoice templates"]])`),
    user('Write a canned reply for the CSV one'),
    bot('**Canned reply: garbled CSV export**\n\n> Hi there, thanks for letting us know! This is an encoding issue with Excel for Windows, and the fix ships in our next release (planned for this Friday). Until then, you can:\n>\n> 1. Open the file in Google Sheets or Numbers, or\n> 2. In Excel, go to Data › From Text/CSV and choose UTF-8 as the encoding.\n\nSaved to the help center under the Exports tag.'),
  ],
}

/** The group chat: people and bots talking about Friday's release. */
export const GROUP = {
  key: 'g-release',
  title: 'v2.4 release',
  bots: ['release', 'frontend', 'backend', 'support'],
  people: ['zhou', 'chen', 'liu'],
  messages: [
    { by: 'zhou', body: 'v2.4 web goes out Friday, iOS next week. Quick sync on what\'s left?' },
    { by: 'bot:release', body: 'Two blockers: the Stripe webhook fix (#216, needs review) and the rollback flag for the multi-currency migration. The iOS cold-launch crash doesn\'t block the web release.' },
    { by: 'chen', body: '#216 can merge this afternoon. Once it\'s in I\'ll replay the 186 events that failed yesterday' },
    { by: 'me', body: '@Frontend @Support let\'s ship the CSV encoding fix in this release too. Support, have the customer note ready', mentions: ['bot:frontend', 'bot:support'] },
    { by: 'bot:frontend', body: 'On it. #485 is in review and will merge before Thursday.' },
    { by: 'bot:support', body: 'Got it. The canned reply is ready, and I\'ll email the 38 customers who reported it once we ship.' },
    { by: 'liu', body: 'I\'ll run the regression suite on staging Thursday morning and post results here' },
    { by: 'bot:backend', body: 'Rehearsed the migration twice on a production snapshot, both under 4 minutes. Rollback flag is in.' },
  ],
}
