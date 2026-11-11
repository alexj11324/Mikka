# Eve World queue transport

The private Node host uses `createNodeQueue` for the pinned World v5 queue interface. This transport supports spec 8 execution. A release must qualify the other World interfaces before starting an Eve host. The adapter does not advertise the v5 spec 9 in-band fence or queue concurrency capabilities.

The container's outbound intercept for `world.internal` points at the named `WorldQueueService` entrypoint. The default Worker exposes no fetch routes. `EVE_RELEASES` maps each retained deployment ID to its private, immutable Eve service binding. The queue consumer posts only to the official workflow flow route. Both sides require a 32-byte hexadecimal queue signing key; the executor authenticates the revision, retry count, delivery time and body. Provision actual keys and service maps through the private release repository.

Configure a native source queue with bounded retries and a dead-letter queue. Entries retain the original deployment ID through failure, deferral, redelivery and dead-lettering. Keep the release service and its verification key until its runs and retained queue entries drain. Redrive the original envelope. Restore the pinned binding if it is missing.

Bind a private R2 bucket as `EVE_QUEUE_PAYLOADS`. Configure its `eve-queue/` object lifecycle to at least 30 days, which exceeds the maximum 14-day source and 14-day DLQ retention combined. Long delays refresh the same content-addressed bytes at each native 24-hour timer hop. Keyed sends use SQL-backed `EVE_CLAIMS` objects to reserve one logical message ID. Cloudflare's native queue owns message delivery.
