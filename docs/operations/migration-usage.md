# Cloudflare migration usage reconciliation

Run this read-only collector for each comparison window. The operator supplies the UTC dates, with an exclusive end. Run from a trusted operator shell with existing read-only credentials. Redirect the results to private evidence storage. The report includes provider project and execution IDs.

~~~sh
node scripts/ops/migration-usage.mjs vercel "$FROM" "$TO" > vercel-usage.json
node scripts/ops/migration-usage.mjs cloudflare "$FROM" "$TO" "$APPLICATION_ID" \
  ./receipts/*/engineering-receipt.json > cloudflare-usage.json
~~~

Vercel reads the team selected by VERCEL_TEAM_ID using the operator-provided VERCEL_TEAM_TOKEN and streams every FOCUS row. It keeps team and project subaccounts, SKU, charge category, currency and consumed unit separate. The first and last returned charge periods show the provider's billing-day boundaries. Compare those boundaries and matching groups across windows. Never sum different currencies. Effective cost and billed cost can differ; use the team invoice to reconcile payment and outstanding charges. Team-attributed rows require additional session or deployment evidence for project ownership.

Cloudflare uses CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN with Account Analytics Read. Select the engineering Container application ID through the account Dashboard. Pass only that application's terminal Actions receipts. Omit the receipt arguments to read aggregate application usage. The report sums billing CPU seconds, allocated memory and disk byte-seconds and egress bytes. Workload samples separately provide peak process memory and workload CPU seconds. A missing provider sample or older receipt without a provider ID produces a null. Check provider reporting lag before concluding usage stopped.

The receipt subset determines the stop-latency sample, deduplicated by Actions run/attempt/workload. Percentiles use the nearest-rank definition. The report counts deadline, interruption and failure outcomes separately. Early cancellation before resource admission has no billed instance ID. Inspect the source receipts before attributing idle cost or time spent waiting on CI.

For Cloudflare net cash and credit, compare provider usage to the account invoice, applied startup-credit transaction, billing period, currency and remaining balance. Store the redacted invoice reference and transaction evidence with the private report. The [private operations entry](https://github.com/alexj11324/mikka-cloud/blob/main/AGENTS.md) owns the company evidence windows and accounting procedure.

[Cloudflare Containers telemetry](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/) · [Vercel FOCUS billing API](https://vercel.com/changelog/access-billing-usage-cost-data-api)
