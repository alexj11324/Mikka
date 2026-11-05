SELECT
    coalesce(nullIf(attributes['mikka.client_kind'], ''), '(unknown kind)') AS client_kind,
    count() AS sampled_queries,
    count() * 10 AS estimated_queries_x10,
    if(count(toFloatOrNull(attributes['mikka.db.response_bytes_approx'])) = 0, NULL, sum(toFloatOrNull(attributes['mikka.db.response_bytes_approx']))) AS sampled_json_bytes,
    if(count(toFloatOrNull(attributes['mikka.db.response_bytes_approx'])) = 0, NULL, sum(toFloatOrNull(attributes['mikka.db.response_bytes_approx'])) * 10) AS estimated_json_bytes_x10,
    countIf(toFloatOrNull(attributes['mikka.db.response_bytes_approx']) IS NULL) AS sampled_queries_missing_bytes
FROM posthog.trace_spans
WHERE {filters}
  AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
  AND startsWith(name, 'pg.query:')
GROUP BY client_kind
ORDER BY estimated_queries_x10 DESC, client_kind ASC
LIMIT 50