# Neon public network transfer reconciliation — Mikka

Prepared 2026-11-03 16:37 UTC for review; no support message has been sent.
No credentials, connection strings, SQL parameters, personal records or message contents are included.

## Resource and request

- Organization: org-sweet-lab-80289846
- Project: autumn-fire-21908520
- Production branch: br-autumn-rain-b5leflom
- Application database: orvilo_mvp
- Public metric: public_network_transfer_bytes

Please help reconcile provider-metered public transfer with application-observed PostgreSQL protocol transfer, and identify remaining sources by endpoint/branch and time window if available. We are still gathering complete application coverage; this packet does not assert a provider billing defect.

## Observed provider values

UTC window | Public bytes | Context
--- | ---: | ---
2026-11-03 11:00–12:00 | 62,894,267 | Before application delta optimization
2026-11-03 12:00–13:00 | 89,687,082 | Before application delta optimization
2026-11-03 13:00–14:00 | 125,739,216 | Mixed deployment; optimization went live 13:31 UTC
2026-11-03 14:00–15:00 | 105,027,042 | Mixed old/new routing until 14:44 UTC
2026-11-03 15:00–16:00 | 119,224,160 | Old full-task query stopped, remaining sources under investigation

Values may receive delayed provider updates. Current partial-hour buckets are deliberately omitted from percentage comparisons. Upgrade Free→Launch occurred at10:56:54Z, and PostgreSQL statistics began at10:57:56Z, so we cannot accurately reconstruct the preceding 1GB from current SQL statistics.

## Verified application facts

- Legacy full-task query ID888626896948297685 has remained923 calls since14:44 UTC; observed production requests to the obsolete deployment stopped.
- Three updated local daemons remain online; one obsolete failed updater has been quarantined. Heartbeat/repository/run-state synchronization explains many small HTTP calls; these are not database billing bytes.
- A Go stream path unnecessarily read19 credential-record columns after each authorization. That read was removed, preserving all live authorization checks; the formal production worker binary was rebuilt from the fix. Real isolated protocol measurement improved15,844→5,711 bytes for20 checks, which is not an overall billing percentage.
- A subsequent live109.69-second SQL interval recorded16,557 statements and13,007 returned-or-affected rows. Repeated permission-hierarchy queries and row locks are being analyzed; affected rows are not automatically network-returned rows.
- Sampled Node row JSON is incomplete evidence. Large-result census captured four thread-list results totaling283,220 JSON bytes (119 rows/result, sampleRate1). Random samples have different weights.
- Cold-start sampling and an initially unobserved workspace connection pool were identified. Both are being corrected before claiming full Node coverage.
- Connection-level PostgreSQL plaintext receive counters are merged in PR1142, awaiting verified formal deployment and actual logs. Their scope excludes startup, TLS, Go processes and unobserved/frozen runtimes; they will not be presented as identical to the provider meter.
- Internal compute_ctl/exporter/vm-monitor activity is loopback and is tracked separately; no evidence currently attributes billable public transfer to it. Other database/role activity and log export configuration have not been conclusively ruled out.

## Metering questions for Neon

1. Confirm the exact metering layer used for public_network_transfer_bytes on this project: PG protocol bytes, HTTP SQL response body, and any additional paths. The current public proxy implementation excludes TLS/header overhead, so we are not attributing the gap to handshakes.
2. Provide or confirm endpoint/branch contributions for the UTC windows above, including primary/read-replica endpoints and all databases. Branch data_transfer_bytes can combine public/private transfer; please clarify whether this project has any PrivateLink contribution.
3. Can any managed-auth, log-export, external replication/export or other client path account for transfer not visible in the app database subset? We have not proven these are enabled.
4. Confirm reporting/backfill delay and whether late usage can be assigned to earlier buckets. We will not interpret an unchanged hourly bucket as zero activity in a minute.
5. If client-side PG protocol totals still cannot reconcile after complete coverage, please inspect proxy-side counters for this project and the affected endpoints.

## Sources and evidence

- Official network transfer: https://neon.com/docs/introduction/network-transfer
- Official egress optimizer: https://github.com/neondatabase/agent-skills/tree/main/skills/neon-postgres-egress-optimizer
- Public proxy source snapshot: https://github.com/neondatabase/neon/tree/fa504217c61bbcaf5c512d75830564541f917f8f/proxy
- Optimization: https://github.com/alexj11324/Mikka/pull/1123
- Go repeated-read fix: https://github.com/alexj11324/Mikka/pull/1139
- Protocol observation: https://github.com/alexj11324/Mikka/pull/1142
- Provider collection restoration: https://github.com/alexj11324/Mikka/pull/1143

Application-side fixes and collection continue in parallel with this support-ready packet. Production statistics have not been reset.
