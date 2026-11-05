SELECT
    coalesce(nullIf(attributes['mikka.error.code'], ''), nullIf(attributes['error.type'], ''), '(unknown code)') AS error_code,
    coalesce(nullIf(attributes['mikka.error.detail'], ''), '(detail not instrumented)') AS error_detail,
    count() AS sampled_error_spans,
    count() * 10 AS estimated_error_spans_x10
FROM posthog.trace_spans
WHERE {filters}
  AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
  AND status_code = 2
GROUP BY error_code, error_detail
ORDER BY sampled_error_spans DESC, error_code ASC, error_detail ASC
LIMIT 100