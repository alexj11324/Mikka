SELECT
    coalesce(nullIf(attributes['mikka.error.code'], ''), nullIf(attributes['error.type'], ''), '(unknown code)') AS error_code,
    coalesce(nullIf(attributes['mikka.error.detail'], ''), '(detail not instrumented)') AS error_detail,
    count() AS sampled_error_spans,
    sum((1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1))) AS estimated_error_spans_weighted
FROM posthog.trace_spans
WHERE {filters}
  AND service_name IN ('mikka-web', 'mikka-daemon')
      AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
  AND status_code = 2
GROUP BY error_code, error_detail
ORDER BY estimated_error_spans_weighted DESC, error_code ASC, error_detail ASC
LIMIT 100
