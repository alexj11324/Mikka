WITH
    toStartOfHour(now()) - INTERVAL 1 HOUR AS evaluated_hour,
    spans AS (
        SELECT timestamp, service_name, status_code,
            coalesce(nullIf(attributes['mikka.route'], ''), 'unknown') AS route,
            coalesce(nullIf(attributes['mikka.error.code'], ''), nullIf(attributes['error.type'], ''), 'unknown_error') AS error_code
        FROM posthog.trace_spans
        WHERE timestamp >= evaluated_hour - INTERVAL 8 DAY
          AND timestamp < evaluated_hour + INTERVAL 1 HOUR
          AND service_name IN ('mikka-web', 'mikka-daemon')
          AND (resource_attributes['deployment.environment.name'] = 'production' OR resource_attributes['deployment.environment'] = 'production')
    ),
    service_start AS (
        SELECT service_name, min(timestamp) AS first_seen FROM spans GROUP BY service_name
    ),
    observed_hours AS (
        SELECT service_name, toStartOfHour(timestamp) AS hour
        FROM spans WHERE timestamp >= evaluated_hour - INTERVAL 7 DAY
        GROUP BY service_name, hour
    ),
    covered_hour_grid AS (
        SELECT h.service_name AS service_name, h.hour AS hour
        FROM observed_hours h JOIN service_start s ON h.service_name = s.service_name
        WHERE h.hour >= toStartOfHour(s.first_seen) + INTERVAL 1 HOUR AND h.hour < evaluated_hour
    ),
    hourly AS (
        SELECT service_name, error_code, toStartOfHour(timestamp) AS hour, count() AS sampled_errors,
            arrayStringConcat(arraySlice(groupUniqArray(route), 1, 5), ', ') AS example_routes
        FROM spans WHERE status_code = 2 AND timestamp >= evaluated_hour - INTERVAL 7 DAY
        GROUP BY service_name, error_code, hour
    ),
    sources AS (
        SELECT service_name, error_code FROM hourly GROUP BY service_name, error_code
    ),
    baseline AS (
        SELECT s.service_name AS service_name, s.error_code AS error_code,
            count() AS baseline_hours, median(coalesce(q.sampled_errors, 0)) AS median_errors
        FROM sources s JOIN covered_hour_grid h ON s.service_name = h.service_name
        LEFT JOIN hourly q ON q.service_name = s.service_name AND q.error_code = s.error_code AND q.hour = h.hour
        GROUP BY s.service_name, s.error_code
    ),
    current_hour AS (
        SELECT * FROM hourly WHERE hour = evaluated_hour
    ),
    current_service AS (
        SELECT service_name, count() AS observed_spans
        FROM spans WHERE timestamp >= evaluated_hour
        GROUP BY service_name
    ),
    metrics AS (
        SELECT s.service_name AS service_name, s.error_code AS error_code,
            coalesce(b.baseline_hours, 0) AS covered_hours,
            coalesce(cs.observed_spans, 0) > 0 AS current_service_observed,
            coalesce(c.sampled_errors, 0) AS current_errors,
            coalesce(c.example_routes, '') AS example_routes,
            coalesce(b.median_errors, 0) AS median_errors,
            greatest(3 * coalesce(b.median_errors, 0), 5) AS threshold_errors
        FROM sources s
        LEFT JOIN current_service cs ON s.service_name = cs.service_name
        LEFT JOIN baseline b ON s.service_name = b.service_name AND s.error_code = b.error_code
        LEFT JOIN current_hour c ON s.service_name = c.service_name AND s.error_code = c.error_code
    ),
    per_source AS (
SELECT
    if(NOT current_service_observed, NULL, if(covered_hours >= 24 AND current_errors > threshold_errors, 1, 0)) AS row_value,
    concat(service_name, ' code=', error_code, ' | UTC hour=', toString(toTimeZone(evaluated_hour, 'UTC')),
        ' | sampled error spans=', if(current_service_observed, toString(current_errors), 'unknown'),
        ' median=', if(covered_hours > 0, toString(round(median_errors, 1)), 'unavailable'),
        ' threshold=', toString(round(threshold_errors, 1)),
        ' | history=', toString(covered_hours), '/168h ', if(NOT current_service_observed, 'NO CURRENT TELEMETRY; evaluation suppressed', if(covered_hours >= 24, 'ready', 'WARMUP no error evaluation')),
        ' | routes (up to 5)=', example_routes,
        ' | fallback error.type/unknown_error; x10 estimate only at 10% sampling') AS row_source,
    service_name, error_code, current_errors, median_errors, threshold_errors, covered_hours, current_service_observed, example_routes, evaluated_hour AS hour_start
FROM metrics
    )
SELECT
    max(row_value) AS value,
    if(countIf(row_value = 1) > 0,
        concat(toString(countIf(row_value = 1)), ' breaching: ', arrayStringConcat(arraySlice(groupArrayIf(row_source, row_value = 1), 1, 5), ' || ')),
        concat('no breach | top: ', argMax(row_source, current_errors))) AS source,
    countIf(row_value = 1) AS breaching_sources,
    count() AS evaluated_sources,
    any(hour_start) AS hour_start
FROM (SELECT * FROM per_source ORDER BY row_value DESC, current_errors DESC, service_name, error_code)