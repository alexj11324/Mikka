WITH db AS (
    SELECT
        1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1) AS sample_weight,
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
    ORDER BY sum(sample_weight) DESC, route ASC
    LIMIT 15
)
SELECT
    hour_utc,
    route,
    count() AS sampled_queries,
    sum(sample_weight) AS estimated_queries_weighted
FROM db
WHERE route IN (SELECT route FROM top_routes)
GROUP BY hour_utc, route
ORDER BY hour_utc ASC, estimated_queries_weighted DESC, route ASC
LIMIT 3000
