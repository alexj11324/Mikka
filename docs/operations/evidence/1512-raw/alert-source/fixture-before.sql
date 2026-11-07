WITH
    toDateTime('2026-11-07 04:00:00', 'UTC') AS evaluated_hour,
    spans AS (
        SELECT toDateTime('2026-11-07 03:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 02:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 01:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 00:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 23:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 22:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 21:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 20:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 19:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 18:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 17:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 16:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 15:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 14:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 13:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 12:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 11:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 10:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 09:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 08:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 07:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 06:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 05:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 04:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 03:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 02:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 01:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-06 00:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 23:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 22:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 21:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 20:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 19:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 18:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 17:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 16:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 15:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 14:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 13:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 12:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 11:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 10:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 09:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 08:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 07:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 06:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 05:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 04:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 03:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-05 02:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 10 AS sample_weight, '/api/rpc' AS route, '' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:05', 'UTC') AS timestamp, 'mikka-web' AS service_name, 3000 AS sample_weight, '/api/rpc' AS route, '15120000-0000-4000-8000-000000000001' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:10', 'UTC') AS timestamp, 'mikka-web' AS service_name, 1 AS sample_weight, '/api/rpc' AS route, '15120000-0000-4000-8000-000000000001' AS request_id, 'aaaaaaaaaaaaaaaa' AS user_hash, 'workspace.getWorkspace' AS rpc_action, false AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:15', 'UTC') AS timestamp, 'mikka-web' AS service_name, 20 AS sample_weight, '/api/rpc' AS route, '15120000-0000-4000-8000-000000000002' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:20', 'UTC') AS timestamp, 'mikka-web' AS service_name, 30 AS sample_weight, '/api/rpc' AS route, '15120000-0000-4000-8000-000000000003' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:21', 'UTC') AS timestamp, 'mikka-web' AS service_name, 1 AS sample_weight, '/api/rpc' AS route, '15120000-0000-4000-8000-000000000003' AS request_id, 'bbbbbbbbbbbbbbbb' AS user_hash, 'bots.getBots' AS rpc_action, false AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:22', 'UTC') AS timestamp, 'mikka-web' AS service_name, 1 AS sample_weight, '/api/rpc' AS route, '15120000-0000-4000-8000-000000000003' AS request_id, 'cccccccccccccccc' AS user_hash, 'coordinator.getCoordinator' AS rpc_action, false AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:25', 'UTC') AS timestamp, 'mikka-web' AS service_name, 40 AS sample_weight, '/api/rpc' AS route, '15120000-0000-4000-8000-000000000004' AS request_id, 'dddddddddddddddd' AS user_hash, 'bots.getBots' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:30', 'UTC') AS timestamp, 'mikka-web' AS service_name, 8830 AS sample_weight, '/api/desktop/rpc' AS route, '15120000-0000-4000-8000-000000000005' AS request_id, '' AS user_hash, '' AS rpc_action, true AS is_db, 1 AS span_bytes, true AS bytes_known
        UNION ALL
        SELECT toDateTime('2026-11-07 04:00:35', 'UTC') AS timestamp, 'mikka-web' AS service_name, 1 AS sample_weight, '/api/desktop/rpc' AS route, '15120000-0000-4000-8000-000000000005' AS request_id, 'aaaaaaaaaaaaaaaa' AS user_hash, 'workspace.getWorkspace' AS rpc_action, false AS is_db, 1 AS span_bytes, true AS bytes_known
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
SELECT route, row_value, current_queries, covered_hours, row_source
FROM per_source ORDER BY route LIMIT 10