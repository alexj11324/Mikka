// English sample content for scripts/demo-data/seed.mjs (--content en): the
// day-to-day of Acme Inc., a small US SaaS team building Acme Ledger. Same
// shape and keys as content.mjs; nothing here names the sample as such.
// Keys are stable: the seed derives row ids from them.

export const WORKSPACE_NAME = 'Acme Inc.'
export const WORKSPACE_SLUG = 'acme'
export const TEAM = { key: 'team-ledger', name: 'Acme Ledger', identifier: 'AL', description: '' }

/** The first chunk of each bot thread's log. */
export const threadOpening = title => `Starting: ${title}.`

/** The other seven people at the company (users with reserved .example emails; nobody can sign in as them). */
export const PEOPLE = [
  { key: 'lin', name: 'Maya Patel', role: 'member', email: 'maya.patel@acmeinc.example' },
  { key: 'chen', name: 'Jordan Lee', role: 'member', email: 'jordan.lee@acmeinc.example' },
  { key: 'zhou', name: 'Sarah Kim', role: 'admin', email: 'sarah.kim@acmeinc.example' },
  { key: 'wang', name: 'Emily Rivera', role: 'member', email: 'emily.rivera@acmeinc.example' },
  { key: 'zhao', name: 'Ryan Brooks', role: 'member', email: 'ryan.brooks@acmeinc.example' },
  { key: 'sun', name: 'Olivia Grant', role: 'member', email: 'olivia.grant@acmeinc.example' },
  { key: 'liu', name: 'Marcus Hall', role: 'member', email: 'marcus.hall@acmeinc.example' },
]

/** Bots; color/shape cover the palette in lib/bot-shapes.ts. */
export const BOTS = [
  { key: 'frontend', name: 'Frontend', color: 'bleu', shape: 'squircle', model: 'claude', repository: 'acme-inc/ledger-web' },
  { key: 'backend', name: 'Backend On-call', color: 'orange', shape: 'hexagone', model: 'codex', repository: 'acme-inc/ledger-api' },
  { key: 'ops', name: 'Infra On-call', color: 'vert', shape: 'galet', model: 'claude', repository: 'acme-inc/ledger-api' },
  { key: 'data', name: 'Analytics', color: 'violet', shape: 'fleur', model: 'mikka', repository: null },
  { key: 'release', name: 'Release Manager', color: 'rouge', shape: 'etoile', model: 'mikka', repository: 'acme-inc/ledger-web' },
  { key: 'ios', name: 'iOS', color: 'turquoise', shape: 'chat', model: 'claude', repository: 'acme-inc/ledger-ios' },
  { key: 'support', name: 'Support', color: 'ambre', shape: 'nuage', model: 'mikka', repository: null },
]

const pr = (n, state, title, repo = 'acme-inc/ledger-web') => ({ url: `https://github.com/${repo}/pull/${n}`, state, title })
const API = 'acme-inc/ledger-api'
const IOS = 'acme-inc/ledger-ios'
const L = {
  bug: { name: 'Bug', color: 'red' }, regression: { name: 'Regression', color: 'red' }, web: { name: 'Web', color: 'blue' },
  ios: { name: 'iOS', color: 'blue' }, api: { name: 'API', color: 'violet' }, payments: { name: 'Payments', color: 'yellow' },
  perf: { name: 'Performance', color: 'yellow' }, ci: { name: 'CI', color: 'gray' }, security: { name: 'Security', color: 'red' },
  customer: { name: 'Customer', color: 'green' }, release: { name: 'v2.4', color: 'green' }, design: { name: 'Design', color: 'blue' },
  db: { name: 'Database', color: 'violet' }, flaky: { name: 'Flaky', color: 'gray' },
}

/**
 * Board tasks. `due` is days from the seed date (negative = overdue).
 * `assignee`: a PEOPLE key, 'me' (the account owner) or 'bot:<key>'.
 */
export const ISSUES = [
  // —— Backlog
  { key: 'i-dark-mode', status: 'backlog', priority: 'low', title: 'Reports line chart is hard to read in dark mode', labels: [L.design, L.web], assignee: 'wang',
    body: ['In dark mode the grid lines and axis labels on the Cash Flow chart almost match the background.', 'Design has dark tokens for it; the frontend hasn\'t picked them up yet.'] },
  { key: 'i-invoice-rounding', status: 'backlog', priority: 'normal', title: 'Multi-currency invoice PDFs total $0.01 more than their line items; a customer caught it during reconciliation, so we need to round at the same step', labels: [L.bug, L.payments, L.customer, L.api], assignee: 'bot:backend',
    body: ['Bluebird Coffee reported that the invoice PDF total is one cent higher than the sum of the line items.', 'Line items are rounded one by one, but the total uses the unrounded amounts. Both should round at the same step.'] },
  { key: 'i-apple-pay-refund', status: 'backlog', priority: 'low', title: 'Partial Apple Pay refunds show the bill as Refunded', labels: [L.payments], assignee: null, due: 14,
    body: ['A partial refund should show Partially refunded and keep the remaining balance.'] },

  // —— Todo
  { key: 'i-safari-blank', status: 'todo', priority: 'urgent', title: 'Sign-in page is blank on Safari 17', labels: [L.bug, L.web, L.regression], assignee: 'lin', due: -1, run: 'failed',
    body: ['Since v2.3.2, /login renders a blank page on macOS Safari 17.x. The console shows `SyntaxError: Invalid regular expression: invalid group specifier name`.', 'Chrome and Firefox are fine. Likely a dependency shipping a lookbehind regex.'],
    checklist: [['Reproduce on BrowserStack', true], ['Find the dependency that added the lookbehind', true], ['Add a Safari smoke spec to Playwright', false]] },
  { key: 'i-rate-limit', status: 'todo', priority: 'high', title: 'Public API customer hits 429s during bulk imports', labels: [L.api, L.customer], assignee: 'chen', due: 3,
    body: ['Cartwheel Commerce imports about 300 orders a minute through the API, and every request comes back 429.', 'The limit is 60 requests per token per minute, which is too tight for bulk endpoints. Options: per-route limits or a /orders:batch endpoint.'],
    pullRequests: [pr(214, 'draft', 'feat(api): per-route rate limits', API)] },
  { key: 'i-dependabot', status: 'todo', priority: 'high', title: 'Dependabot: axios 1.6.x SSRF vulnerability (CVE-2024-39338)', labels: [L.security, L.web], assignee: 'bot:frontend', run: 'waiting',
    body: ['Dependabot opened a PR to bump to 1.7.4, but two API mock tests fail in CI.', 'Need to figure out whether the mocks are wrong or axios changed behavior.'] },
  { key: 'i-sentry-spike', status: 'todo', priority: 'normal', title: 'Sentry: spike in `TypeError: Cannot read properties of undefined (reading \'amount\')`', labels: [L.bug, L.web], assignee: 'liu', due: 2,
    body: ['200+ events an hour since 9 p.m. last night, all on the Bill Details page.', 'Every one comes from a brand-new account with no transactions yet.'] },

  // —— Doing
  { key: 'i-slow-report', status: 'doing', priority: 'high', title: 'Monthly report endpoint at 8s p95: slow database query', labels: [L.perf, L.db, L.api], assignee: 'bot:ops', run: 'running',
    body: ['p95 for /api/reports/monthly went from 1.2s to 8s. The slow query log points at a range scan on `transactions` by `(account_id, created_at)`.', 'There\'s no composite index, and the report re-aggregates everything on every request. We could pre-aggregate by month.'],
    pullRequests: [pr(209, 'merged', 'chore(db): add slow query logging', API), pr(217, 'open', 'perf(db): composite index on transactions', API)] },
  { key: 'i-next-build', status: 'doing', priority: 'normal', title: 'Production build went from 3 to 11 minutes after the Next.js 15 upgrade', labels: [L.perf, L.ci, L.web], assignee: 'bot:frontend', run: 'running', due: 1,
    body: ['Since the upgrade, `next build` takes 11 minutes in CI.', '`--profile` shows the time going to type checking and one huge barrel file.'],
    pullRequests: [pr(488, 'open', 'build: drop barrel imports in components/ui')] },
  { key: 'i-ios-crash', status: 'doing', priority: 'urgent', title: 'iOS 2.4.0 crashes on cold launch on iOS 16', labels: [L.ios, L.bug, L.regression], assignee: 'bot:ios', run: 'waiting', due: -2,
    body: ['TestFlight 2.4.0 (312) crashes right away on cold launch on iOS 16.7. Crashlytics shows `EXC_BAD_ACCESS` in a Keychain read.', 'iOS 17 is fine.'] },
  { key: 'i-flaky-e2e', status: 'doing', priority: 'normal', title: 'Create invoice e2e spec is flaky in CI', labels: [L.ci, L.flaky], assignee: 'me',
    body: ['5 of the last 30 main builds failed, every time on invoice-create.spec.ts timing out while waiting for the Saved toast.'],
    checklist: [['Reproduce locally with --repeat-each 50', true], ['Remove waitForTimeout(500) from the spec', false], ['Wait on the API response instead of the toast', false]] },
  { key: 'i-release-parent', status: 'doing', priority: 'high', title: 'Get v2.4 ready to ship', labels: [L.release], assignee: 'zhou', due: 4,
    body: ['v2.4 is planned for Friday: multi-currency accounts, invoice templates and the iOS widget.'] },

  // —— Review
  { key: 'i-csv-garbled', status: 'review', priority: 'normal', title: 'Accented names come out garbled when CSV exports open in Excel', labels: [L.bug, L.customer, L.web], assignee: 'bot:frontend', run: 'succeeded',
    body: ['Opening an exported bills CSV in Excel on Windows turns names like "Café Olé" into "CafÃ© OlÃ©". Numbers and Google Sheets are fine.', 'We need to write a UTF-8 BOM at the start of the file.'],
    pullRequests: [pr(485, 'open', 'fix(export): prepend UTF-8 BOM for Excel')] },
  { key: 'i-stripe-webhook', status: 'review', priority: 'high', title: 'Stripe webhook signature check fails, so subscription renewals aren\'t recorded', labels: [L.payments, L.api, L.bug], assignee: 'chen', due: 0,
    body: ['Since yesterday every `invoice.paid` event returns 400: `No signatures found matching the expected signature for payload`.', 'Cause: after the gateway upgrade the body is parsed to JSON before it reaches us, and signature verification needs the raw body.'],
    pullRequests: [pr(216, 'open', 'fix(stripe): verify webhook against raw body', API), pr(218, 'draft', 'chore: replay failed invoice.paid events', API)] },
  { key: 'i-widget', status: 'review', priority: 'normal', title: 'iOS home screen widget: today\'s activity', labels: [L.ios, L.release], assignee: 'zhao',
    body: ['Small and medium sizes, refreshing every 30 minutes.'],
    pullRequests: [pr(97, 'open', 'feat(widget): today summary widget', IOS), pr(95, 'merged', 'chore: app group for widget data', IOS), pr(93, 'closed', 'wip: widget prototype', IOS)] },

  // —— Done
  { key: 'i-lcp', status: 'done', priority: 'normal', title: 'Cut home page LCP from 3.4s to 1.6s', labels: [L.perf, L.web], assignee: 'bot:frontend', run: 'succeeded',
    body: ['Switched the hero image to AVIF with a preload and subset the fonts.'], pullRequests: [pr(471, 'merged', 'perf(home): preload hero image, subset fonts')] },
  { key: 'i-paypal-retry', status: 'done', priority: 'high', title: 'PayPal IPN isn\'t retried after a timeout', labels: [L.payments, L.api], assignee: 'bot:backend', run: 'succeeded',
    body: ['PayPal treats a handler that takes longer than 5 seconds as failed. We now store the event first and process it async.'], pullRequests: [pr(205, 'merged', 'fix(paypal): ack IPN before processing', API)] },
  { key: 'i-privacy-link', status: 'done', priority: 'low', title: 'Privacy policy link on the sign-up page 404s', labels: [L.web], assignee: 'wang',
    body: ['The URL changed with the marketing site redesign.'], pullRequests: [pr(479, 'merged', 'fix: privacy policy link')] },
  { key: 'i-sub-notes', status: 'done', priority: 'normal', title: 'Write the v2.4 release notes', labels: [L.release], assignee: 'bot:release', parent: 'i-release-parent', body: ['Customer-facing notes for the changelog and the in-app What\'s New.'] },
  { key: 'i-sub-migration', status: 'done', priority: 'high', title: 'Dry-run the multi-currency data migration', labels: [L.release, L.db], assignee: 'chen', parent: 'i-release-parent', body: ['Ran it twice on staging against a production snapshot; both finished in under 4 minutes.'] },
  { key: 'i-sub-regression', status: 'todo', priority: 'high', title: 'v2.4 regression pass', labels: [L.release], assignee: 'liu', parent: 'i-release-parent', body: ['Run the core flows once on web and once on iOS.'] },

  { key: 'i-okr', status: 'todo', priority: 'normal', title: 'Write the Q4 engineering OKR retro', labels: [], assignee: 'me', due: 5,
    body: ['Reliability (P1 incidents, Sentry error rate), delivery (release cadence), cost (cloud bill).'] },

  // —— Canceled / duplicate
  { key: 'i-android', status: 'canceled', priority: 'low', title: 'Android app', labels: [], assignee: null, body: ['Not this quarter. Polish iOS and web first.'] },
  { key: 'i-safari-dup', status: 'duplicate', priority: 'normal', title: 'Sign-in page is just white on my Mac', labels: [L.bug], assignee: null, duplicateOf: 'i-safari-blank', body: ['From a customer email. Same as "Sign-in page is blank on Safari 17".'] },
]

/** Computers in Settings › Devices. All disabled with no token, so nothing is ever dispatched to them. */
export const DEVICES = [
  // `online` keeps lastSeenAt ahead of now so the row reads online.
  { key: 'd-mbp', name: 'Alex\'s MacBook Pro', hostname: 'alex-mbp.local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', online: true, autoSchedule: false,
    harnesses: [{ harness: 'claude_code', installed: true, version: '2.4.1' }, { harness: 'codex', installed: true, version: '0.61.0' }] },
  { key: 'd-staging', name: 'staging-server', hostname: 'staging-01', deviceType: 'server', platform: 'linux', arch: 'x64', lastSeenMinutes: 42, autoSchedule: true,
    harnesses: [{ harness: 'codex', installed: true, version: '0.61.0' }] },
  { key: 'd-mini', name: 'Mac mini (iOS builds)', hostname: 'build-mini.local', deviceType: 'laptop', platform: 'darwin', arch: 'arm64', lastSeenMinutes: 60 * 24 * 9, autoSchedule: null,
    harnesses: [{ harness: 'claude_code', installed: true, version: '2.1.0' }] },
]

/** Coding agents the threads run on. */
export const AGENTS = [
  { key: 'ag-claude', name: 'Claude Code · MacBook', harness: 'claude_code', device: 'd-mbp' },
  { key: 'ag-codex', name: 'Codex · staging', harness: 'codex', device: 'd-staging' },
]

const text = (delta, id = 't1') => ({ type: 'text-delta', id, delta })
const tool = id => ({ type: 'tool-input-available', toolCallId: id })

/**
 * Threads. `minutesAgo` is when it started; finished ones also have `minutes`.
 * Running/waiting threads carry no lease, so run recovery never reclaims them.
 */
export const RUNS = [
  { key: 'r-slow-report', issue: 'i-slow-report', bot: 'ops', agent: 'ag-codex', status: 'running', minutesAgo: 30,
    prompt: 'Monthly report endpoint at 8s p95\nFind it with EXPLAIN ANALYZE first, then add the index and compare on staging.',
    lastReply: 'Index is live on staging and p95 dropped from 8.1s to 0.9s. Running the regression suite now.',
    chunks: [text('EXPLAIN ANALYZE: Seq Scan on transactions, rows=2.1M, 7.6s.'), tool('a'), tool('b'), text('Adding a composite index on (account_id, created_at) on branch perf/transactions-index.', 't2'), tool('c'), text('Index is live on staging and p95 dropped from 8.1s to 0.9s. Running the regression suite now.', 't3')] },
  { key: 'r-next-build', issue: 'i-next-build', bot: 'frontend', agent: 'ag-claude', status: 'running', minutesAgo: 45,
    prompt: 'Build got slower after the Next.js 15 upgrade\nProfile it with --profile first, then fix.',
    lastReply: 'With the components/ui barrel imports gone, the local build takes 4m 10s. CI is running.',
    chunks: [text('next build --profile: 4 minutes in type checking, and components/ui/index.ts is imported by 300+ files.'), tool('a'), tool('b'), text('Switched to per-file imports and committed build: drop barrel imports (a3f9c21).', 't2'), tool('c'), text('With the components/ui barrel imports gone, the local build takes 4m 10s. CI is running.', 't3')] },
  { key: 'r-dependabot', issue: 'i-dependabot', bot: 'frontend', agent: 'ag-claude', status: 'waiting_input', minutesAgo: 90,
    prompt: 'Land the Dependabot axios 1.7.4 bump and fix the failing tests',
    lastReply: 'Both failures come from mocks that rely on axios\'s internal adapter field. Switch to msw, or just patch these two tests?',
    chunks: [text('CI failures: two cases in api/client.test.ts, both overwrite axios.defaults.adapter directly.'), tool('a'), tool('b'), text('Both failures come from mocks that rely on axios\'s internal adapter field. Switch to msw, or just patch these two tests?', 't2')] },
  { key: 'r-ios-crash', issue: 'i-ios-crash', bot: 'ios', agent: 'ag-claude', status: 'waiting_input', minutesAgo: 150,
    prompt: 'Cold-launch crash on iOS 16\nReproduce it in the simulator first, then check the Crashlytics stack.',
    lastReply: 'We read a kSecAttrAccessibleAfterFirstUnlock Keychain item before the app finishes launching. Should I move that read after didFinishLaunching?',
    chunks: [text('Cold-launched 10 times on the iOS 16.4 simulator: 10 crashes.'), { type: 'data-computer', data: { runId: '{{run:r-ios-crash}}', botId: '{{bot:ios}}', task: 'Cold-launch 10 times on the iOS 16.4 simulator and capture the crash logs' } }, tool('a'), text('We read a kSecAttrAccessibleAfterFirstUnlock Keychain item before the app finishes launching. Should I move that read after didFinishLaunching?', 't2')] },
  { key: 'r-safari', issue: 'i-safari-blank', bot: 'frontend', agent: 'ag-codex', status: 'failed', minutesAgo: 60 * 5, minutes: 14,
    prompt: 'Reproduce the blank Safari 17 sign-in page with a failing Playwright spec',
    lastReply: 'The Playwright WebKit download failed, so the spec never ran.',
    error: 'browserType.launch: Executable doesn\'t exist at /home/runner/.cache/ms-playwright/webkit-2104/pw_run.sh',
    chunks: [text('Installing Playwright WebKit.'), tool('a')] },
  { key: 'r-csv', issue: 'i-csv-garbled', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 20, minutes: 22,
    prompt: 'Accented names are garbled when exported CSVs open in Excel', lastReply: 'Opened PR #485: writes a UTF-8 BOM at the start of the file, with unit tests.',
    chunks: [text('Without a BOM, Excel reads a CSV using the system code page (Windows-1252).'), tool('a'), tool('b'), text('Opened PR #485: writes a UTF-8 BOM at the start of the file, with unit tests.', 't2')] },
  { key: 'r-lcp', issue: 'i-lcp', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 50, minutes: 37,
    prompt: 'Get home page LCP under 2 seconds', lastReply: 'Merged #471. Lighthouse LCP is 1.6s.',
    chunks: [text('The LCP element is the hero image (a 1.2MB JPEG).'), tool('a'), text('Merged #471. Lighthouse LCP is 1.6s.', 't2')], artifacts: ['a-lcp-compare'] },
  { key: 'r-paypal', issue: 'i-paypal-retry', bot: 'backend', agent: 'ag-codex', status: 'succeeded', minutesAgo: 60 * 70, minutes: 41,
    prompt: 'PayPal IPN isn\'t retried after a timeout', lastReply: 'Merged #205: ack first, process async, with an idempotency key.',
    chunks: [text('The IPN handler calls the invoice service synchronously, 6.2s on average.'), tool('a'), tool('b'), text('Merged #205: ack first, process async, with an idempotency key.', 't2')] },
  { key: 'r-safari-analysis', issue: 'i-safari-blank', bot: 'frontend', agent: 'ag-claude', status: 'succeeded', minutesAgo: 60 * 8, minutes: 26,
    prompt: 'Find the root cause of the blank Safari 17 page and write it up', lastReply: 'Root cause analysis is up as an artifact.',
    chunks: [text('Bisecting dependency changes in v2.3.1..v2.3.2: date-fns-tz 3.1 introduced a lookbehind.'), tool('a'), text('Root cause analysis is up as an artifact.', 't2')], artifacts: ['a-safari-rca'] },
  { key: 'r-release-notes', issue: null, bot: 'release', agent: 'ag-codex', status: 'succeeded', minutesAgo: 60 * 3, minutes: 6,
    prompt: 'Draft the v2.4 release notes', lastReply: 'Draft is up as an artifact.',
    chunks: [text('Collecting the 23 PRs merged since v2.3.2.'), tool('a'), text('Draft is up as an artifact.', 't2')], artifacts: ['a-release-notes'] },
  { key: 'r-rate-limit-cancel', issue: 'i-rate-limit', bot: 'backend', agent: 'ag-codex', status: 'succeeded', minutesAgo: 60 * 26, minutes: 18,
    prompt: 'Reproduce the public API 429s on staging', lastReply: 'Reproduced with a load script: at 300 requests a minute, 80% come back 429, matching Cartwheel Commerce\'s logs.',
    chunks: [text('Running k6 at 300 requests a minute against POST /v1/orders.'), tool('a'), text('Reproduced with a load script: at 300 requests a minute, 80% come back 429, matching Cartwheel Commerce\'s logs.', 't2')] },
]

/** Artifacts the threads handed over; content is stored inline. */
export const ARTIFACTS = [
  { key: 'a-release-notes', kind: 'markdown', title: 'v2.4 release notes', author: 'Release Manager', versions: [
    '# Acme Ledger v2.4\n\n## New\n\n- Multi-currency accounts\n- Invoice templates\n',
    '# Acme Ledger v2.4\n\n## New\n\n- **Multi-currency accounts**: track USD, CAD and EUR in one ledger; reports convert at the daily rate.\n- **Invoice templates**: add your own header, logo and notes, then export to PDF.\n- **iOS home screen widget**: see today\'s activity without opening the app.\n\n## Fixed\n\n- Accented names no longer come out garbled when CSV exports open in Excel\n- Bills sometimes stayed unpaid after a PayPal payment\n- The home page loads about twice as fast\n\n## Known issues\n\n- Bank statement import doesn\'t support multi-currency accounts yet\n',
  ] },
  { key: 'a-safari-rca', kind: 'markdown', title: 'Blank Safari page: root cause', author: 'Frontend', versions: [
    '# Sign-in page blank on Safari 17: root cause\n\n## Impact\n\nAfter v2.3.2 shipped on Oct 28, 2026, users on macOS Safari 17.0–17.3 got a blank sign-in page. That\'s about 6% of web sign-ins.\n\n## Root cause\n\n`date-fns-tz` went from 3.0 to 3.1, and its new time zone parser uses named groups with a lookbehind:\n\n```js\n/(?<=GMT)(?<sign>[+-])(?<hours>\\d{2})/\n```\n\nSafari didn\'t support lookbehind before 17.4, so the whole bundle failed to parse.\n\n## Fix\n\n1. Pin `date-fns-tz@3.0.1` (shipped in v2.3.3)\n2. Add a WebKit smoke spec to CI\n3. Check syntax against `browserslist` at build time\n\n## Timeline\n\n| Time (PT) | Event |\n|---|---|\n| Oct 28, 6:02 PM | v2.3.2 ships |\n| Oct 28, 9:40 PM | First customer email |\n| Oct 29, 10:15 AM | Dependency identified |\n| Oct 29, 11:30 AM | v2.3.3 ships |\n',
  ] },
  { key: 'a-lcp-compare', kind: 'html', title: 'Home page LCP: before and after', author: 'Frontend', versions: [
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Home page LCP: before and after</title><style>body{font:14px system-ui;margin:24px;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 12px;text-align:right}th:first-child,td:first-child{text-align:left}</style><h1>Home page LCP: before and after</h1><table><tr><th>Metric</th><th>Before</th><th>After</th></tr><tr><td>LCP</td><td>3.4s</td><td>1.6s</td></tr><tr><td>Hero image</td><td>1.2MB JPEG</td><td>180KB AVIF</td></tr><tr><td>Fonts</td><td>410KB</td><td>64KB (subset)</td></tr><tr><td>Lighthouse performance</td><td>62</td><td>94</td></tr></table></html>',
  ] },
]

/** Suggestion rows, dated more than a day back so the 8 a.m. briefing never picks them up. */
export const SUGGESTIONS = [
  { key: 's-review', source: 'github', action: 'review', title: 'fix(stripe): verify webhook against raw body', actionTitle: 'Review Jordan Lee\'s PR: Stripe webhook signature check', actor: 'Jordan Lee', level: 'high', required: true, hoursAgo: 26, url: 'https://github.com/acme-inc/ledger-api/pull/216' },
  { key: 's-linear', source: 'linear', action: 'handle', title: 'iOS 2.4.0 crashes on cold launch on iOS 16', actionTitle: 'Handle the issue Ryan Brooks assigned: iOS 16 cold-launch crash', actor: 'Ryan Brooks', level: 'critical', required: true, hoursAgo: 28, url: null },
  { key: 's-slack', source: 'slack', action: 'reply', title: 'Can v2.4 go out Friday? Marketing\'s newsletter goes out Saturday', actionTitle: 'Reply to Sarah Kim: can v2.4 ship Friday before Saturday\'s newsletter', actor: 'Sarah Kim', level: 'ask', required: false, hoursAgo: 31, url: null },
  { key: 's-gmail', source: 'gmail', action: 'reply', title: 'Complaint: I was charged twice for my subscription this month', actionTitle: 'Reply to Bluebird Coffee: double charge, send the refund status today', actor: 'Dana Whitfield, Bluebird Coffee', level: 'high', required: false, hoursAgo: 40, url: null },
  { key: 's-notion', source: 'notion', action: 'read', title: '3 new comments on the Q4 product roadmap', actionTitle: 'Read 3 new comments on the Q4 roadmap', actor: 'Emily Rivera', level: 'normal', required: false, hoursAgo: 75, url: null },
]

/** What each bot remembers (coordinator_sessions.memory, Markdown lines). */
export const BOT_MEMORY = {
  frontend: '- Support Safari 16 and later.\n- Import components file by file; no barrel files.',
  backend: '- Payment webhooks: store first, then process, always with an idempotency key.\n- Database migrations go in their own PR.',
  ops: '- Production changes only on weekdays, 10 a.m.–5 p.m. PT.',
  release: '- Freeze main the day before a release.\n- iOS phased release starts at 20% on day one.',
}

/**
 * More threads per bot, so each bot shows the parallel work it runs: several
 * at once, some waiting on a person, the rest finished. A thread is named by
 * its first prompt line. [title, status, hoursAgo, lastReply]
 */
const R = 'running', S = 'succeeded', C = 'cancelled'
export const BOT_THREADS = {
  frontend: [
    ['Add virtual scrolling to the bills list', R, 0.6, 'Moved the list to @tanstack/react-virtual; measuring scroll frame rate with 5,000 rows.'],
    ['Move settings forms to react-hook-form', R, 1.2, '4 of 6 forms migrated, validation rules unchanged.'],
    ['Dark mode: report chart colors', R, 2.1, 'Swapped lines and grid to the dark tokens from the design file; comparing screenshots now.'],
    ['Add a Safari WebKit smoke spec for sign-in', R, 3, 'CI now uses the official Playwright image; 3 of 5 WebKit specs pass.'],
    ['Accessibility pass on invoice preview', S, 9, 'axe reports 0 critical issues; fixed 3 inputs missing labels (#486).'],
    ['Replace moment with date-fns', S, 20, 'Bundle is 61KB smaller and every date snapshot matches (#482).'],
    ['Fix mobile bottom nav pushed up by the keyboard', S, 28, 'Listening to visualViewport on iOS Safari now; merged #480.'],
    ['Upgrade Storybook to 8.4', S, 44, 'Upgraded, fixed config for 2 addons, 0 visual diffs.'],
    ['Bill details empty state', S, 52, 'New accounts with no transactions see a getting-started card; opened #487.'],
    ['Move ESLint to flat config', S, 70, 'Switched to eslint-plugin-import-x; migration done with 0 new warnings (#483).'],
    ['Redo the pricing cards on the home page', C, 96, 'Design is still changing, so I stopped here.'],
  ],
  backend: [
    ['Per-route rate limits for the public API', R, 0.8, 'Token bucket is now configured per route, 600/min for bulk endpoints; writing integration tests.'],
    ['Replay 186 failed invoice.paid events', R, 1.5, 'Replayed 112 of 186, all recorded, no double charges.'],
    ['Round invoice PDF amounts at the same step', R, 2.6, 'Line items and totals now round together; diffing against 1,000 past invoices.'],
    ['Apple Pay partial refund status', R, 4, 'After the refund webhook we query the remaining balance; adding unit tests.'],
    ['Add idempotency keys to /v1/orders', S, 11, 'Supports the Idempotency-Key header; repeats within 24 hours return the first result (#215).'],
    ['Upgrade Node 18 to 22', S, 22, 'All tests pass and cold starts are about 15% faster (#212).'],
    ['Paginate the audit log endpoint', S, 30, 'Switched to cursor pagination; large accounts went from 4s to 120ms (#211).'],
    ['Clean up stale API tokens', S, 47, 'Revoked 1,284 tokens unused for 180 days and emailed the affected customers.'],
    ['Daily report missing a day across time zones', S, 60, 'Day boundaries now use the account time zone, with cross-zone tests (#210).'],
    ['Make exports an async job', S, 75, 'Streams in batches of 5,000 rows; a 500k-row export takes 38s on staging (#213).'],
    ['Evaluate a GraphQL gateway', C, 120, 'Deprioritized, so I stopped here.'],
  ],
  ops: [
    ['Add the transactions composite index in production', R, 0.5, 'Waiting for the 10 p.m. window; confirmed on staging that CONCURRENTLY doesn\'t block writes.'],
    ['Clean up Sentry alert rules', R, 1.4, 'Merging 46 alerts into 12, grouped by service and severity.'],
    ['Cut log retention from 90 to 30 days', R, 3.5, 'Audit logs keep 180 days, everything else 30; migrating the buckets now.'],
    ['Redis memory alert', S, 8, 'Session keys had no TTL. With one set, memory went from 92% to 41%.'],
    ['Low CDN cache hit rate', S, 18, 'Added content hashes to static assets; hit rate went from 71% to 96%.'],
    ['Daily backup restore drill', S, 26, 'Restored yesterday\'s snapshot to a new instance in 11 minutes; checks pass.'],
    ['Upgrade Postgres 15 to 16', S, 50, 'Rehearsed twice on staging with under 3 minutes of downtime; scheduled for early Saturday.'],
    ['TLS certificate auto-renewal failed', S, 66, 'The DNS validation token had expired. Rotated it and added an expiry reminder.'],
    ['Staging disk full', S, 80, 'Pruned old Docker images to free 38GB and added a weekly cleanup job.'],
    ['Scale up the Kubernetes node pool', S, 90, 'Added 2 nodes in us-east-1b; peak CPU went from 88% to 52%.'],
    ['Roll out OpenTelemetry', C, 110, 'Doing Sentry performance monitoring first; pushed this out.'],
  ],
  data: [
    ['October business review', R, 0.7, 'Revenue, conversion and retention are done; writing the takeaways.'],
    ['Break down the trial-to-paid funnel', R, 1.8, 'Split by signup channel; paid search converts worst (6.1%).'],
    ['Churned customer interview list', R, 2.5, 'Pulled 40 paying accounts that churned in the last 30 days, sorted by MRR; adding contacts.'],
    ['Pricing page A/B test results', S, 10, 'Variant B (annual preselected) converts 1.8 points better, p=0.03.'],
    ['Invoice feature usage', S, 21, 'Customers who sent an invoice retain 14 points better at 90 days.'],
    ['Monthly channel ROI report', S, 33, 'Content marketing has the best ROI (4.2); paid social the worst (0.8).'],
    ['Summarize the NPS survey', S, 46, 'NPS is 41. Top complaints: slow exports and the Mac sign-in issue.'],
    ['Audit tracking events', S, 58, 'The invoice_sent event fires twice on iOS; flagged it to the iOS bot.'],
    ['Customer segmentation model', S, 72, 'Five tiers by monthly volume and activity, synced to the CRM.'],
    ['Backfill year-over-year data', S, 85, 'Restored last March from backup; the YoY report is complete.'],
    ['Competitor pricing research', C, 100, 'Marketing already did this; canceled.'],
  ],
  release: [
    ['Build v2.4.0-rc.1', R, 0.9, 'Web build is done; running the staging smoke suite (42/60).'],
    ['Compile the v2.4 changelog', R, 1.6, 'Pulled 9 customer-facing changes out of 23 PRs.'],
    ['App Store review assets', R, 3.2, 'Generating 6.7" and 5.5" screenshots from Emily\'s final copy, 8 of 12 done.'],
    ['Ship the v2.3.3 hotfix', S, 30, 'Pinned date-fns-tz@3.0.1; blank Safari tickets dropped to zero after release.'],
    ['Ship v2.3.2', S, 98, 'Web and iOS shipped together; no noticeable change in the Sentry error rate.'],
    ['Release checklist template', S, 120, 'Added migration dry-run, rollback flag and support heads-up to the template.'],
    ['Generate the changelog page', S, 140, 'Built from merged PR labels and live on the marketing site.'],
    ['Ship v2.3.1', S, 170, 'Fixed 3 payment issues; went to 100% after 24 hours of phased rollout.'],
    ['Submit iOS 2.3.3 for review', S, 190, 'Approved in 18 hours.'],
    ['Rotate the iOS distribution certificate', S, 100, 'Updated the signing cert in CI; build succeeded and uploaded to TestFlight.'],
    ['Merge the v2.3.0 patch', C, 210, 'Already in v2.3.1; canceled.'],
  ],
  ios: [
    ['Regression test the iOS 16 cold-launch crash', R, 0.6, 'Cold-launched 20 times on each of 4 devices; 0 crashes so far.'],
    ['Widget refresh strategy', R, 1.3, 'Switched to a 30-minute Timeline refresh; battery test in progress.'],
    ['Keyboard covers the add-transaction screen', R, 2.4, 'Added a safeAreaInset to the amount field; checking on iPhone SE.'],
    ['Face ID sign-in', R, 3.8, 'Confirms the password on first enable; testing the fallback to password on device.'],
    ['Upload Crashlytics symbols', S, 12, 'CI uploads dSYMs automatically, so crash stacks show line numbers now.'],
    ['Dark mode icons', S, 24, 'Added the 18 missing dark icons in #96.'],
    ['iPad split view layout', S, 36, 'Bills list and details side by side; merged #94.'],
    ['Push permission prompt', S, 54, 'We ask after the first transaction now; opt-in went from 38% to 61%.'],
    ['Move to Xcode 16', S, 68, 'Fixed 12 new warnings; build time unchanged.'],
    ['Automatic TestFlight distribution', S, 82, 'Merges upload to TestFlight and notify the beta group; worked 3 times in a row.'],
    ['Evaluate a watchOS app', C, 130, 'Not doing it for now.'],
  ],
  support: [
    ['Reply to Bluebird Coffee about the double charge', R, 0.4, 'Refund is submitted; drafting the email.'],
    ['Top questions this week', R, 1.1, 'Sorted 142 tickets; garbled CSV exports lead with 38.'],
    ['Talk to Cartwheel Commerce about API limits', R, 2.2, 'Told them per-route limits ship this week; helping them move to the bulk endpoint.'],
    ['Canned reply for garbled CSV exports', S, 6, 'Saved to the help center under the Exports tag.'],
    ['Notify customers about the Safari fix', S, 27, 'Emailed the 27 customers who reported it; 19 have confirmed.'],
    ['Help center: how to send an invoice', S, 40, 'Published a step-by-step guide; related tickets are down 30%.'],
    ['Simplify the refund process', S, 56, 'Cut approvals from 3 steps to 2; average handling time went from 2 days to 4 hours.'],
    ['Weekly CSAT report', S, 74, 'CSAT is 94%; most negative ratings are about response time.'],
    ['Clean up ticket tags', S, 92, 'Merged duplicates, from 63 tags down to 24.'],
    ['Sync tickets to Linear', S, 66, 'Tickets tagged Bug create Linear issues automatically; 12 synced so far.'],
    ['After-hours auto-reply', C, 115, 'Staying with a human on call for now.'],
  ],
}
