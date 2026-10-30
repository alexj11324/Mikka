# CI aggregation before the application ingress (proposal)

This is a deployment plan, not an enabled service. CI webhook subscriptions
have been disabled, and the polling replacement is not deployed; this leaves a
CI detection gap. The 15-minute suggestions Worker still calls the briefing
endpoint for unrelated work. No repository CI changes are needed for the plan
below.

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

The existing backend issues the Worker a short-lived installation token limited
to one repository and metadata, Pull requests, Checks, Commit statuses,
Contents and Actions read, within the App's existing permissions. The Worker
never receives the long-lived App signing key. It encrypts the short-lived
token in the existing application database under a domain-separated key derived
from its existing `CRON_SECRET`; the cache is bound to the watch, owner,
repository, account, run, scope and generation. This permits reuse across cold
Worker isolates. An active polling lease serializes renewal; expiration or a
binding change forces another issuance. Each issuance is an additional Vercel
authentication request, distinct from the one final result request.

The Worker code is behind `CI_POLL_ENABLED` and remains disabled. It needs the
existing Worker to have a reviewed read-capable Hyperdrive binding for the
separate workspace database (`CI_WORKSPACE_HYPERDRIVE`) and the existing
callback secret and application URL. No new identity, GitHub permission or
long-lived App key distribution is proposed. The app-side
`MIKKA_CI_EXTERNAL_POLLING` flag must only be enabled after the poller, token
issuer and final callback have been accepted. The 15-minute Worker schedule is
code-only until deployment. PR, issue, comment and review subscriptions, the
webhook endpoint and the App remain active.

The Hyperdrive connection also needs a least-privilege review: its existing
database role must be checked before reuse, rather than assuming that a broad
app role is appropriate. The workspace role must also support the row locks
used on team, issue-link, and membership tables; ordinary SELECT alone is not
sufficient. The final callback needs authenticated, narrowly
scoped authority and must recheck the task, head, account and membership before
committing an idempotent claim. No credentials, bindings, subscriptions or
external configuration are changed by this proposal.

With a cached token, a full poll needs nine GitHub requests: three to recheck
the person's access and six for PR, checks, statuses, branch protection, rules
and Actions. Branch protection and rules are cached for 30 minutes, reducing
an ordinary cache-hit poll to seven. The Worker bypasses the cache and reads a
fresh complete snapshot before queuing a result; the application also rechecks
fresh before claim. After a commit result has been accepted, same-head monitoring uses only
the three access checks and one PR-head read. Issuance adds about six GitHub
requests and one Vercel authentication request, approximately once per hour
per active watch. Pagination, retries and interrupted leases add more. At a
15-minute interval, one watch running for two hours without completion is about
64 polling calls plus up to nine for the final fresh read, 12 issuance calls,
two authentication requests and one final result request. This is an estimate,
not a reduction of GitHub traffic.
The batch limit is two watches per invocation, with backoff and jitter;
backlog delays later watches. A global rate budget remains to be implemented
and latency and cost must be measured before deployment.

The parent reports that CI event subscriptions have already been disabled;
the active poller is not deployed, leaving a temporary CI detection gap.
Pull request events used by other product features continue. The current
15-minute briefing requests also continue for
their unrelated work; they must not be represented as one CI result request.
Polling cannot prove that an unknown third-party check will never register in
the future. Missing required contexts remain pending, and a quiet window bounds
but does not eliminate that uncertainty. Same-commit reruns after a claimed
result intentionally do not generate another automatic wake.

Poll read errors are stored as bounded categories and retried. Token, access and workspace errors currently collapse to unavailable; delivery errors retain only retry counts. Durable user-facing notification for persistent or unrecoverable errors remains required before cutover.
