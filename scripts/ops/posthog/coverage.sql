SELECT
    service_name,
    count() AS sampled_spans,
    count() * 10 AS estimated_spans_x10,
    countIf(startsWith(name, 'pg.query:')) AS sampled_db_queries,
    countIf(startsWith(name, 'pg.query:')) * 10 AS estimated_db_queries_x10,
    countIf(status_code = 2) AS sampled_error_spans,
    countIf(status_code = 2) * 10 AS estimated_error_spans_x10,
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