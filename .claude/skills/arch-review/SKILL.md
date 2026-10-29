---
name: arch-review
description: Review distributed systems architecture for correctness, resilience, and operability. Always use this skill when designing or reviewing service architectures, splitting a monolith, thinking through service boundaries, failure modes, data ownership, consistency tradeoffs, message queues, or event-driven designs. Use when the user says "review this architecture", "is this design sound", "what could go wrong", "how should these services communicate", "will this scale", "what are the failure modes", or "we're moving to microservices". Read this before recommending any architectural change.
---

# Arch Review

Distributed systems fail in ways that single-process systems don't. The goal of an architecture review is to find the failure modes, consistency problems, and operational gaps before they find you in production.

## How to run a review

Work through these areas in order: earlier sections surface problems that change how you think about later ones.

---

## 1. Service boundaries and data ownership

**Each service should own its data.** If two services share a database, they're not two services; they're one service split across two codebases. Shared databases create hidden coupling: schema changes in one service break the other; transactions span service boundaries and become distributed transactions (hard) or are abandoned (inconsistent).

**Ask for each service:**

- What data does it own? (Only it can write directly to this data)
- What does it depend on from other services? (Read-only copies, published events, or synchronous queries)
- What does it publish to other services?

**Red flags:**

- Two services writing to the same table
- A service querying another service's database directly
- Business logic that's split between two services and requires tight coordination to remain consistent

**Bounded context drift**: if a service has grown to own data and logic from multiple unrelated domains, it's becoming a distributed monolith. Consider whether it should be split.

---

## 2. Communication patterns

**Synchronous (request/response)**: service A calls service B and waits for a response. Simple to reason about but creates temporal coupling: if B is slow or down, A is impacted.

Use synchronous calls when:

- The caller needs the result to proceed
- The operation must be consistent (the result of B's work affects what A does next)
- Latency SLAs require a direct response

**Asynchronous (events/messages)**: service A publishes an event; service B consumes it independently. Decouples services temporally: B can be down and A keeps working; B processes when it recovers.

Use asynchronous messaging when:

- The caller doesn't need an immediate response
- The operation can be eventually consistent
- You want to decouple the producer's and consumer's availability

**Hybrid patterns**: command-query separation, request-response over a queue (for async workflows that still need a result), saga pattern for distributed transactions.

**Synchronous call depth**: a chain of synchronous calls A → B → C → D means A's latency is the sum of all, and A fails if any of B, C, or D fail. Flatten deep chains where possible; parallelize independent calls.

---

## 3. Consistency and data flow

**Eventual vs strong consistency**: distributed systems that don't use distributed transactions (and you should avoid those) are eventually consistent. The question is: which operations can tolerate eventual consistency and which cannot?

- Financial transactions, inventory reservation, access control: usually need strong consistency
- User profiles, content, notifications, analytics: usually fine with eventual consistency

**Dual-write problem**: when you need to write to two systems atomically (e.g., database + message queue), you can't do it without distributed coordination. Common approaches:

- **Transactional outbox**: write the event to an outbox table in the same transaction as the data, then a separate process publishes from the outbox. Reliable; avoids lost events.
- **Change data capture (CDC)**: stream changes from the database's write-ahead log. No code changes needed in the write path; requires infrastructure (Debezium, etc.).
- **Saga pattern**: for multi-step workflows, model each step as a transaction with a compensating action. Complex but avoids distributed locks.

**Idempotency**: in an eventually-consistent or retry-heavy system, operations will be executed more than once. Every consumer and handler should be idempotent, meaning executing it twice has the same result as once. Track processed message IDs to deduplicate; use upsert semantics rather than insert-only where possible.

---

## 4. Failure modes

For each service and integration point, ask: what happens when this fails?

**Dependency failure**: if service A depends on service B, what happens to A when B is down, slow, or returning errors?

- **Circuit breaker**: fail fast after N consecutive failures; retry after a backoff period; don't let a slow dependency drain connection pools and thread pools
- **Timeout**: every network call needs a timeout. Without one, a slow dependency holds a connection or thread indefinitely.
- **Fallback**: can the operation succeed with degraded or cached data? Is there a default behavior that's better than an error?

**Cascade failures**: a slow downstream causes upstream threads/connections to pile up, exhausting the upstream's resources, which causes it to fail, which cascades further up. Mitigations: bulkhead isolation (separate thread pools per dependency), circuit breakers, shedding load before you're overwhelmed.

**Split-brain**: in systems with leader election or distributed consensus, a network partition can cause multiple nodes to believe they are the leader. Understand your consensus mechanism (Raft, Paxos, Zookeeper) and what it guarantees during a partition.

**At-least-once delivery and duplicate messages**: most message queues guarantee at-least-once delivery (exactly-once is hard and expensive). Consumers must handle duplicate messages. See idempotency above.

**Clock skew**: distributed systems cannot assume clocks are synchronized. Don't rely on timestamps for ordering; use logical clocks (Lamport timestamps, vector clocks) or sequence numbers for ordering guarantees.

---

## 5. Scalability

**Stateless services scale horizontally.** If a service holds in-memory session state, requests from the same user must always route to the same instance (sticky sessions). That's a scaling and reliability constraint. Move state to a shared store.

**Hot spots**: does traffic or data distribute evenly, or is there a hot partition? A single user with 10x the activity of others can saturate one shard while others are idle. Design partition keys to distribute load.

**Backpressure**: when a producer produces faster than a consumer can consume, queues grow unboundedly. Does the system apply backpressure (slow the producer) or does it drop messages or apply memory pressure? Know which and design for it.

**Database as bottleneck**: in many systems, the database is the first thing to saturate. Read replicas handle read scale; sharding handles write scale; caching reduces load. Understand which bottleneck you'll hit first and at what scale.

---

## 6. Observability

A system you can't observe is a system you can't operate. Three pillars:

**Metrics** (what's happening right now):

- Request rate, error rate, latency (the RED method: Rate, Errors, Duration)
- Resource utilization: CPU, memory, connection pool usage, queue depth
- Business metrics: not just technical health but user-visible outcomes (orders placed, payments processed)
- Each service must emit these; each integration point (DB calls, external API calls, queue publishes/consumes) should too

**Logs** (what happened):

- Structured (JSON), not free-form: logs are queried, not read
- Include: request ID (for tracing a single request across services), user or tenant ID, operation name, outcome, duration
- Sample at high volume; don't log at DEBUG level in production without a sampling rate
- Don't log sensitive data (tokens, PII, passwords)

**Traces** (how a request moved through the system):

- Distributed tracing (OpenTelemetry, Jaeger, Zipkin) connects spans across service boundaries using a shared trace ID propagated in request headers
- Essential for diagnosing latency in multi-service call chains
- Without traces, you know a request was slow, but you don't know which service was responsible

**Alerting**: alert on symptoms (user-visible impact: high error rate, high latency) not just causes (high CPU, low disk). An alert that fires without user impact creates noise and trains responders to ignore alerts.

---

## 7. Operational concerns

**Deployment**: can each service be deployed independently? If deploying service A requires coordinating with service B, you've lost the key benefit of service decomposition. Maintain backward compatibility across service versions during rolling deploys.

**Configuration management**: secrets and config should not be baked into images or code. Use a secrets manager (Vault, AWS Secrets Manager, etc.) and externalize config. Audit who can read production secrets.

**Graceful shutdown**: services should stop accepting new requests on SIGTERM, drain in-flight requests, and close connections cleanly. Abrupt shutdown under load causes request failures and connection pool errors in callers.

**Health checks**: every service needs a health endpoint (liveness and readiness separately if your orchestrator distinguishes them). Readiness should fail if the service's dependencies are unavailable. Don't let traffic route to an instance that can't serve it.

**Runbooks**: for every known failure mode, document what to check and how to mitigate. On-call engineers shouldn't be figuring this out at 3am for the first time.
