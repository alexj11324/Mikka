WITH db AS (
    SELECT
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
    ORDER BY sum(json_bytes) DESC, count() DESC, route ASC
    LIMIT 15
)
SELECT
    hour_utc,
    route,
    count() AS sampled_queries,
    count() * 10 AS estimated_queries_x10,
    if(count(json_bytes) = 0, NULL, sum(json_bytes)) AS sampled_json_bytes,
    if(count(json_bytes) = 0, NULL, sum(json_bytes) * 10) AS estimated_json_bytes_x10,
    count() - count(json_bytes) AS sampled_queries_missing_bytes
FROM db
WHERE route IN (SELECT route FROM top_routes)
GROUP BY hour_utc, route
ORDER BY hour_utc ASC, estimated_json_bytes_x10 DESC NULLS LAST, route ASC
LIMIT 3000