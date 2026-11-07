SELECT
    service_name,
    count() AS sampled_spans,
    sum((1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1))) AS estimated_spans_weighted,
    countIf(startsWith(name, 'pg.query:')) AS sampled_db_queries,
    sumIf((1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1)), startsWith(name, 'pg.query:')) AS estimated_db_queries_weighted,
    countIf(status_code = 2) AS sampled_error_spans,
    sumIf((1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1)), status_code = 2) AS estimated_error_spans_weighted,
    formatDateTime(toTimeZone(min(timestamp), 'UTC'), '%Y-%m-%d %H:%i:%S') AS first_span_utc,
    formatDateTime(toTimeZone(max(timestamp), 'UTC'), '%Y-%m-%d %H:%i:%S') AS latest_span_utc,
    count(DISTINCT toStartOfHour(toTimeZone(timestamp, 'UTC'))) AS observed_hour_buckets,
    round(dateDiff('second', min(timestamp), max(timestamp)) / 3600, 2) AS observed_span_hours,
    countIf(startsWith(name, 'pg.query:') AND coalesce(nullIf(attributes['mikka.route'], ''), 'unknown') IN ('unknown', '(unknown route)')) AS sampled_db_queries_unattributed_route,
    countIf(startsWith(name, 'pg.query:') AND toFloatOrNull(attributes['mikka.db.response_bytes_approx']) IS NULL) AS sampled_db_queries_missing_bytes
FROM posthog.trace_spans
WHERE {filters}
  AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
GROUP BY service_name
ORDER BY sampled_spans DESC
LIMIT 10
