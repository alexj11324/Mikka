-- PREPARED ONLY; NOT EXECUTED. Project 670821 / US / Logs cluster.
-- Actual nonzero lowercase 32-hex trace ID; fixed UTC [start,end), <= 1 hour.
-- No service or environment restriction belongs in WHERE.
WITH coalesce(
    nullIf(resource_attributes['deployment.environment.name'], ''),
    resource_attributes['deployment.environment']
) AS observed_environment
SELECT
    multiIf(
        service_name = 'mikka-web', 'mikka-web',
        service_name = 'mikka-daemon', 'mikka-daemon',
        empty(coalesce(service_name, '')), 'missing',
        'other'
    ) AS service_class,
    multiIf(
        observed_environment = 'production', 'production',
        observed_environment = 'preview', 'preview',
        observed_environment = 'staging', 'staging',
        observed_environment = 'development', 'development',
        observed_environment = 'test', 'test',
        empty(coalesce(observed_environment, '')), 'missing',
        'other'
    ) AS environment_class,
    count() AS span_rows
FROM posthog.trace_spans
WHERE timestamp >= toDateTime('{{window_start_utc}}', 'UTC')
  AND timestamp < toDateTime('{{window_end_utc}}', 'UTC')
  AND trace_id = base64Encode(unhex('{{trace_id_hex}}'))
GROUP BY service_class, environment_class
ORDER BY service_class, environment_class
LIMIT 32
