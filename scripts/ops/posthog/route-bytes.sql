WITH db AS (
    SELECT
        1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1) AS sample_weight,
        formatDateTime(toTimeZone(timestamp, 'UTC'), '%Y-%m-%d %H:00') AS hour_utc,
        coalesce(nullIf(attributes['mikka.route'], ''), '(unknown route)') AS route,
        toFloatOrNull(attributes['mikka.db.response_bytes_approx']) AS json_bytes
    FROM posthog.trace_spans
    WHERE {filters}
      AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
      AND startsWith(name, 'pg.query:')
), top_routes AS (
    SELECT route
    FROM db
    GROUP BY route
    ORDER BY sum(json_bytes * sample_weight) DESC, sum(sample_weight) DESC, route ASC
    LIMIT 15
)
SELECT
    hour_utc,
    route,
    count() AS sampled_queries,
    sum(sample_weight) AS estimated_queries_weighted,
    if(count(json_bytes) = 0, NULL, sum(json_bytes)) AS sampled_json_bytes,
    if(count(json_bytes) = 0, NULL, sum(json_bytes * sample_weight)) AS estimated_json_bytes_weighted,
    count() - count(json_bytes) AS sampled_queries_missing_bytes
FROM db
WHERE route IN (SELECT route FROM top_routes)
GROUP BY hour_utc, route
ORDER BY hour_utc ASC, estimated_json_bytes_weighted DESC NULLS LAST, route ASC
LIMIT 3000
