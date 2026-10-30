# CI aggregation before the application ingress (proposal)

This is a deployment plan, not an enabled service. The current GitHub App sends
`workflow_run` webhooks directly to Vercel and the 15-minute suggestions Worker
calls the briefing endpoint. Filtering those webhooks in the app does not reduce
incoming requests. No repository CI changes are needed for the plan below.

The existing `mikka-linear-sync` Worker already has the application database
Hyperdrive binding; it is the candidate execution location. Add a separate,
bounded scheduled CI poller to that Worker, without changing the existing Linear
schedule or its request handler. It reads only task-bound rows created by
`registerCiPublication`, leases due rows atomically and verifies that the PR,
installation, repository, owner and task remain authorized. PR publication
starts tracking; a newer head supersedes the earlier head, a closed PR or
revocation ends tracking, and the existing 48-hour watch is the upper bound.
The Worker reads the current PR head and all known checks, statuses, Actions
runs and required contexts. It waits for completion and a stable observation,
then posts one idempotently keyed result to the application. A same-head rerun
after a result is claimed does not start another Agent. A newer commit is a new
result. Network retries can send the final request more than once; the receiver
must deduplicate it transactionally.

The existing Worker does not currently have the GitHub App signing key. The
least-privilege deployment needs a repository-scoped installation token with
metadata, Pull requests, Checks, Commit statuses, Contents and Actions read,
using the permissions already granted to the App. Two delivery options require
explicit review:

1. The existing backend issues a short-lived, repository-scoped token to the
   Worker. It avoids distributing the long-lived App key, but issuance and
   renewal cause additional application requests; for runs beyond a token's
   lifetime this does not satisfy a literal one-request total.
2. Deliver the existing App signing key to the existing Worker using an
   authorized secret sync, then mint the same scoped tokens there. This avoids
   issuance requests to Vercel, but exposes a more powerful long-lived key to
   another runtime and needs explicit approval and a dedicated access review.
   It is not an additional GitHub permission or a new identity, but it is an
   additional secret distribution and is not configured here.

The current draft Worker code implements option 2 behind `CI_POLL_ENABLED`;
it is disabled and has not received the key. Option 1 is a design alternative,
not implemented. Enabling either option requires a separate authorization and
deployment decision. The app-side `MIKKA_CI_EXTERNAL_POLLING` cutover flag must
only be enabled after the poller and its delivery callback have been accepted.
The 15-minute Worker schedule is code-only until deployment. The only GitHub
subscription to remove at cutover is `workflow_run`; PR, issue, comment and
review subscriptions, the webhook endpoint and the App remain active.

The Hyperdrive connection also needs a least-privilege review: its existing
database role must be checked before reuse, rather than assuming that a broad
app role is appropriate. The final callback needs authenticated, narrowly
scoped authority and must recheck the task, head, account and membership before
committing an idempotent claim. No credentials, bindings, subscriptions or
external configuration are changed by this proposal.

An ordinary complete poll currently needs approximately twelve GitHub requests:
five to verify the person's current repository access, plus one scoped token
issuance and PR, checks, statuses, branch protection, rules and Actions reads.
Pagination and recovery may add more. At one poll every 15 minutes for 48
hours, a single active watch could consume about 2,304 GitHub requests before
pagination and retries. The current batch limit is two watches per Worker
invocation; a backlog delays later watches. A bounded adaptive schedule and
global concurrency/rate limits are needed, and latency/cost must be measured
before deployment. The current polling adapter fails closed for shared tasks:
it polls only issues owned by the watched user until the separate workspace
membership lease is integrated and tested in the Worker.

After the poller is deployed and verified, removing the GitHub App's
`workflow_run` subscription stops those intermediate deliveries at the source;
this is a separate external action. Pull request events used by other product
features continue. The current 15-minute briefing requests also continue for
their unrelated work; they must not be represented as one CI result request.
Polling cannot prove that an unknown third-party check will never register in
the future. Missing required contexts remain pending, and a quiet window bounds
but does not eliminate that uncertainty. Same-commit reruns after a claimed
result intentionally do not generate another automatic wake.
