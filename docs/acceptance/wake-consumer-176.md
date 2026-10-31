# Durable wake: real consumer follow-up

## Exact environment and scope

The 2026-10-31 follow-up reused the preserved GitHub CI application artifact
for `375d670937ca06c53e47f336870481d38520c1fe`, running at
`http://localhost:3112`. Its original signed test-environment descriptor and
the existing PostgreSQL 17 `mikka_native_mcp_e2e` database with 154 migrations
were retained. No application build, schema replay, identity reset, rate-counter
reset or quarantined-account revival was performed.

The old service had stopped. Starting the same database under a new origin was
correctly refused by `ENVIRONMENT_OWNERSHIP_FILE_REQUIRED`; that attempt did
not replace the environment binding. The release owner then coordinated a
restart of the original origin and immutable artifact with new private logs.
The normal deployment attestation passed before any account was allocated.

The runner's source base was `e5261087e69529a32dd3e3a3c6afb665379ef844`.
`lib/coordinator/wake-recovery.ts` and `lib/coordinator/store.ts` were compared
against the preserved application source and were unchanged. The runner uses
that frozen source tree's production functions. It does not claim every later
application module is equivalent to the older artifact.

## Real elapsed run

From 10:52:22 to 10:59:32 UTC:

1. Normal automatic owner/peer authentication and the existing first-party MCP
   public-client authorization produced a genuine Mikka-issued session. This
   was ordinary isolated test setup, not another Google/GitHub subscription
   OAuth acceptance or an external-provider credential import.
2. A real Node SHA-256 computation was sent through the authenticated
   `send_to_coordinator` MCP tool. Its existing host-created `run_report`
   event has `tier=result`; this is Agent coordination data, not user approval
   or a claimed official coding-CLI inference.
3. Ten simultaneous wake claims selected that same event exactly once. The
   controlled workflow-start transport failed three times. Actual durable
   attempt counts and next retry timestamps were independently read back:
   60 seconds, then 120 seconds, then 240 seconds. Real elapsed time passed;
   no clock, `nextWakeAt`, attempt or lease guard was rewritten.
4. A fresh recovery instance found the event without a new message. The fourth
   attempt started a separate process running the real `takeInbox` production
   consumer. Its own ten concurrent takes consumed the event once. A second
   consumer process consumed nothing; replay and another claim were refused.
5. The actual owner chat HTTP endpoint returned exactly one event containing
   the original result and digest. The peer's actual chat endpoint did not
   expose it. The final event row had attempt four and a persisted delivery
   timestamp. Measured recovery plus consumer/readback time was 430,546 ms.

The account lease retained its existing 300,000 ms maximum and renewed through
the normal helper. The initial exhausted pool failed as `POOL_EXHAUSTED` and
that failure was retained; the supported `prepare({pairs:4})` operation added
one fresh pair while preserving the three quarantined pairs. The successful
fixture was released dirty rather than represented as reusable.

## Evidence and reproduction

- Actual successful result: `/tmp/mikka-wake176-consumer-G4ArXr/result.json`.
- Execution log: `/tmp/mikka-wake176-real-consumer-2.log`.
- Exact application restart/attestation log:
  `/tmp/mikka-wake176375-restored-launch.log`.
- Existing credential-evidence audit passed over five result/process/service
  files. No credential value, OAuth token or cookie is included here.
- `scripts/acceptance/wake-consumer-closeout.mjs` SHA-256 during this run:
  `3addcf47a13086d1114a713c7d8873047ab73b5403c57ecc22f8cfe133df6cdb`.
- `tests/support/mcp-closeout-session.mjs` SHA-256:
  `69359f38fce99a1201bd4dc00e9df0497abf8aba75bbc1d251af42f749f2950b`.

Use a separately started, normally attested isolated application with its
matching source tree and existing test-account environment variables. Set
`MIKKA_WAKE_SOURCE_ROOT` to that source tree; optionally set
`MIKKA_WAKE_ACCOUNT_PAIRS` within the existing pool's allowed range. Then run:

```sh
node --import ./scripts/server-test.mjs --import tsx \
  scripts/acceptance/wake-consumer-closeout.mjs
```

The runner takes at least seven real minutes. Audit the private evidence using
the existing `auditEvidence` helper before publishing any selected files.

## Limits

This advances actual authenticated producer, durable recovery, independent
consumer and chat readback evidence. The start transport deliberately invokes
the consumer subprocess; it is not the hosted Workflow SDK worker. The
measurement is not a production minute-worker recovery SLA.

No assistant response, native CLI model completion, `run_finished` model
classification, external provider effect or full #176 acceptance is claimed.
The real completion-state/token/event transaction has separate PostgreSQL
coverage; this peer-report scenario does not replace it. Broader fixed-version
task-finished-to-model-result acceptance remains distinct.
