# Pool callback context binding microbenchmark — #1512

## Scope and source

This is one local run of the actual `manageDatabasePool` wrapper in
`6180cd8889006f4e1618c2549b1aa12d13506ee8`, on Node 24.22.1 / V8 13.6.233.17-node.58,
Linux x64, with the installed pg 8.23.1.

- Source: `lib/db/pool-lifecycle.ts`, 1,327 bytes.
- Source Git blob: `5732f6a883aa55c38bd220508439670561b0b2be`.
- Source SHA-256: `25bfe3d3803e2e299d3572ff34b932e430806efecded767cda2b201291e0bdf6`.
- Benchmark script SHA-256: `52cb43d89e2c07375353590c850baa741afab75dc1581c0eaa1b3c5ec9f1a1b8`.
- Full result SHA-256: `3d2eef342c68b6f3d0084f362e47d3b1ad02636138753092de869b040b9aa3df`.

The existing HTTP benchmark is bound to 7be76630, request attribution to a6a584ae,
and the AI/native generation measurements to their recorded source hashes.
They do not measure this later Pool callback binding. They remain historical
evidence; this run supplies only the newly added synchronous queue/binding cost.

## Method

The candidate imports and invokes the real source wrapper once on a real
`pg.Pool`. The control uses the same real Pool with no callback wrapper and an
equivalent inert error listener. Both have max=1 and use a controlled in-memory
Client. A connection remains checked out; each measured callback must enter
the real Pool queue. Releasing the previous lease under a foreign context
synchronously drains that queue. The newly acquired lease is retained for the
next operation.

Three synthetic AsyncLocalStorage stores are active. All candidate callbacks
must observe the initiating caller's stores; all control callbacks observe the
foreign releaser's stores, demonstrating the intended behavioral difference.
There is no mock of the Pool queue or of `AsyncLocalStorage.bind`.

The benchmark warms 1,000 pairs, then measures 2,000 independent operation
pairs. It alternates control→candidate and candidate→control order. Each
operation records two synchronous elapsed intervals separately: registration /
enqueue, and release / queue drain. Their sum excludes context setup and
assertions outside those intervals. The clock is `process.hrtime.bigint`, so
these are single-operation **elapsed** samples, not direct per-operation CPU
samples.

A separate phase runs 512 matched batch pairs of 128 operations. It records
whole-batch elapsed time and `process.cpuUsage` user+system CPU. These windows
include identical synthetic context setup, validation and driver work for both
variants. Dividing by 128 yields a **batch mean per operation**. Quantiles over
these batch means are not individual-operation quantiles.

Pool setup, source import and warm-up are outside measured windows.
`idleTimeoutMillis=0` excludes unrelated idle timer scheduling. Client
`query` throws if invoked; `net.Socket.connect` and `fetch` are guarded to
reject network access. No data, credentials, PostgreSQL service or external
model is involved. No performance threshold was introduced.

## Results

### Individually timed active queue path (2,000 pairs)

All numbers below are milliseconds.

| Statistic | Unwrapped | Wrapped | Paired wrapped − unwrapped |
| --- | ---: | ---: | ---: |
| Mean | 0.00106055 | 0.00461071 | 0.00355016 |
| p50 | 0.000611 | 0.002443 | 0.001813 |
| p95 | 0.001573 | 0.005919 | 0.004648 |
| p99 | 0.003085 | 0.037106 | 0.036084 |

The last column is the distribution of each pair's difference; it is **not**
the difference between independent distribution quantiles. Negative paired
differences and outliers remain in the raw receipt. The largest paired elapsed
increase was 0.900599 ms; the minimum was −0.149285 ms. Scheduling and garbage
collection can affect these elapsed samples.

### CPU batch means (512 pairs × 128 operations)

All numbers below are microseconds per operation after dividing each batch's
CPU time by 128.

| Statistic over batch means | Unwrapped | Wrapped | Paired difference |
| --- | ---: | ---: | ---: |
| Mean | 6.21944 | 9.77177 | 3.55234 |
| p50 | 2.46094 | 4.45313 | 1.94531 |
| p95 | 18.22656 | 31.85156 | 20.31250 |
| p99 | 96.21094 | 103.34375 | 100.93750 |

These CPU values include process work such as garbage collection during the
batch. The p99 of the paired batch means is not a p99 per-query CPU cost and
must not be presented as one. Full batch wall-time data and all raw pairs are
also retained in `result.json`.

## Correctness and cleanup

Each variant executed 68,536 callbacks: 1,000 warm-up + 2,000 individually timed
+ 512 × 128 batch operations. Every operation exercised one queued acquisition.
All 68,536 candidate callbacks retained caller stores; all 68,536 control
callbacks observed foreign releaser stores. Neither variant had a context
mismatch against its expected behavior. Both finished with an empty queue.

- Network attempts: 0.
- SQL calls: 0.
- Controlled clients constructed: 2 total, one per Pool.
- Both Pools ended successfully.
- Network guards restored.
- External resources created: 0.
- Runs: 1; no performance-driven rerun or sample removal.

## Limits

This isolates the synchronous cost of the current callback binding on one
local Node process. It excludes PostgreSQL handshakes, SQL/network latency,
HTTP, real OTel SDK recording/export, PostHog transport, model work, Vercel
suspension behavior and production concurrency. It does not replace Native
whole-window SQL acceptance, production end-to-end latency or production
observability acceptance.

Reproduction:

```sh
node --experimental-strip-types benchmark.mjs /absolute/path/to/exact/repo result.json
```

The script refuses a different source hash, Node version or Vercel environment.

