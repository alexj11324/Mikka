WITH
    toStartOfHour(now()) - INTERVAL 1 HOUR AS evaluated_hour,
    spans AS (
        SELECT timestamp, service_name,
            1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1) AS sample_weight,
            coalesce(nullIf(attributes['mikka.route'], ''), 'unknown') AS route,
            startsWith(name, 'pg.query:') AS is_db,
            toFloatOrZero(attributes['mikka.db.response_bytes_approx']) AS span_bytes,
            attributes['mikka.db.response_bytes_approx'] IS NOT NULL
                AND match(attributes['mikka.db.response_bytes_approx'], '^[0-9]+([.][0-9]+)?$') AS bytes_known
        FROM posthog.trace_spans
        WHERE timestamp >= evaluated_hour - INTERVAL 8 DAY
          AND timestamp < evaluated_hour + INTERVAL 1 HOUR
          AND service_name = 'mikka-web'
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
        SELECT service_name, route, toStartOfHour(timestamp) AS hour,
            count() AS observed_queries, sum(sample_weight) AS estimated_queries,
            sum(span_bytes * sample_weight) AS estimated_bytes, sumIf(sample_weight, bytes_known) AS estimated_queries_with_bytes
        FROM spans WHERE is_db AND timestamp >= evaluated_hour - INTERVAL 7 DAY
        GROUP BY service_name, route, hour
    ),
    sources AS (
        SELECT service_name, route FROM hourly GROUP BY service_name, route
    ),
    baseline AS (
        SELECT s.service_name AS service_name, s.route AS route,
            count() AS baseline_hours, median(coalesce(q.estimated_queries, 0)) AS median_queries
        FROM sources s JOIN covered_hour_grid h ON s.service_name = h.service_name
        LEFT JOIN hourly q ON q.service_name = s.service_name AND q.route = s.route AND q.hour = h.hour
        GROUP BY s.service_name, s.route
    ),
    byte_baseline AS (
        SELECT s.service_name AS service_name, s.route AS route,
            count() AS baseline_hours, median(coalesce(q.estimated_bytes, 0)) AS median_bytes
        FROM sources s JOIN covered_hour_grid h ON s.service_name = h.service_name
        LEFT JOIN hourly q ON q.service_name = s.service_name AND q.route = s.route AND q.hour = h.hour
        WHERE coalesce(q.estimated_queries, 0) = 0
           OR coalesce(q.estimated_queries_with_bytes, 0) >= 0.95 * q.estimated_queries
        GROUP BY s.service_name, s.route
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
        SELECT s.service_name AS service_name, s.route AS route,
            coalesce(b.baseline_hours, 0) AS covered_hours,
            coalesce(cs.observed_spans, 0) > 0 AS current_service_observed,
            coalesce(bb.baseline_hours, 0) AS byte_covered_hours,
            coalesce(c.estimated_queries, 0) AS current_queries,
            coalesce(c.estimated_bytes, 0) AS current_bytes,
            coalesce(c.estimated_queries, 0) - coalesce(c.estimated_queries_with_bytes, 0) AS missing_byte_queries,
            if(coalesce(c.estimated_queries, 0) = 0, 1, coalesce(c.estimated_queries_with_bytes, 0) / c.estimated_queries) AS current_byte_coverage,
            coalesce(b.median_queries, 0) AS median_queries,
            coalesce(bb.median_bytes, 0) AS median_bytes,
            greatest(3 * coalesce(b.median_queries, 0), 2000) AS threshold_queries,
            greatest(3 * coalesce(bb.median_bytes, 0), 10000000) AS threshold_bytes
        FROM sources s
        LEFT JOIN current_service cs ON s.service_name = cs.service_name
        LEFT JOIN baseline b ON s.service_name = b.service_name AND s.route = b.route
        LEFT JOIN byte_baseline bb ON s.service_name = bb.service_name AND s.route = bb.route
        LEFT JOIN current_hour c ON s.service_name = c.service_name AND s.route = c.route
    ),
    per_source AS (
SELECT
    if(NOT current_service_observed, NULL,
        if((covered_hours >= 24 AND current_queries > threshold_queries)
           OR (byte_covered_hours >= 24 AND current_byte_coverage >= 0.95 AND current_bytes > threshold_bytes), 1, 0)) AS row_value,
    concat(service_name, ' ', route, ' | UTC hour=', toString(toTimeZone(evaluated_hour, 'UTC')),
        ' | estimated queries=', if(current_service_observed, toString(current_queries), 'unknown'), ' median=', if(covered_hours > 0, toString(round(median_queries, 1)), 'unavailable'),
        ' threshold=', toString(round(threshold_queries, 1)),
        '; estimated JSON bytes=', if(current_service_observed, toString(round(current_bytes, 0)), 'unknown'), ' median=', if(byte_covered_hours > 0, toString(round(median_bytes, 0)), 'unavailable'),
        ' threshold=', toString(round(threshold_bytes, 0)), '; missing bytes=', toString(missing_byte_queries), '/', toString(current_queries),
        ' | history queries=', toString(covered_hours), '/168h bytes=', toString(byte_covered_hours), '/168h',
        if(NOT current_service_observed, ' NO CURRENT TELEMETRY; evaluation suppressed', if(covered_hours < 24, ' WARMUP; monthly 50% and heartbeat remain', '')),
        ' | per-span 1/sample_rate; legacy rate=0.1; bytes require 95% weighted coverage; not provider egress') AS row_source,
    route, current_queries, current_bytes, median_queries, median_bytes, threshold_queries, threshold_bytes,
    covered_hours, byte_covered_hours, current_service_observed, missing_byte_queries, current_byte_coverage, evaluated_hour AS hour_start
FROM metrics
    )
SELECT
    max(row_value) AS value,
    if(countIf(row_value = 1) > 0,
        concat(toString(countIf(row_value = 1)), ' breaching: ', arrayStringConcat(arraySlice(groupArrayIf(row_source, row_value = 1), 1, 5), ' || ')),
        concat('no breach | top: ', argMax(row_source, current_bytes))) AS source,
    countIf(row_value = 1) AS breaching_sources,
    count() AS evaluated_sources,
    any(hour_start) AS hour_start
FROM (SELECT * FROM per_source ORDER BY row_value DESC, current_bytes DESC, current_queries DESC)
