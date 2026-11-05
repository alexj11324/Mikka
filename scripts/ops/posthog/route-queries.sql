WITH db AS (
    SELECT
        formatDateTime(toTimeZone(timestamp, 'UTC'), '%Y-%m-%d %H:00') AS hour_utc,
        coalesce(nullIf(attributes['mikka.route'], ''), '(unknown route)') AS route
    FROM posthog.trace_spans
    WHERE {filters}
      AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
      AND startsWith(name, 'pg.query:')
), top_routes AS (
    SELECT route
    FROM db
    GROUP BY route
    ORDER BY count() DESC, route ASC
    LIMIT 15
)
SELECT
    hour_utc,
    route,
    count() AS sampled_queries,
    count() * 10 AS estimated_queries_x10
FROM db
WHERE route IN (SELECT route FROM top_routes)
GROUP BY hour_utc, route
ORDER BY hour_utc ASC, estimated_queries_x10 DESC, route ASC
LIMIT 3000