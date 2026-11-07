WITH
    toStartOfHour(now()) - INTERVAL 1 HOUR AS evaluated_hour,
    spans AS (
        SELECT timestamp, service_name,
            1 / coalesce(toFloatOrNull(attributes['mikka.trace.sample_rate']), 0.1) AS sample_weight,
            coalesce(nullIf(attributes['mikka.route'], ''), 'unknown') AS route,
            if(match(attributes['mikka.request_id'], '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), attributes['mikka.request_id'], '') AS request_id,
            if(match(attributes['mikka.user_id_hash'], '^[0-9a-f]{16}$'), attributes['mikka.user_id_hash'], '') AS user_hash,
            if(length(attributes['mikka.rpc.action']) <= 120 AND match(attributes['mikka.rpc.action'], '^[A-Za-z][A-Za-z0-9_-]*[.][A-Za-z][A-Za-z0-9_]*$'), attributes['mikka.rpc.action'], '') AS rpc_action,
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
    source_start AS (
        SELECT service_name, route, min(timestamp) AS first_seen
        FROM spans GROUP BY service_name, route
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
        SELECT h.service_name AS service_name, h.route AS route, any(s.first_seen) AS first_seen
        FROM hourly h JOIN source_start s ON h.service_name = s.service_name AND h.route = s.route
        GROUP BY h.service_name, h.route
    ),
    baseline AS (
        SELECT s.service_name AS service_name, s.route AS route,
            count() AS baseline_hours, median(coalesce(q.estimated_queries, 0)) AS median_queries
        FROM sources s JOIN covered_hour_grid h ON s.service_name = h.service_name
        LEFT JOIN hourly q ON q.service_name = s.service_name AND q.route = s.route AND q.hour = h.hour
        WHERE h.hour >= toStartOfHour(s.first_seen) + INTERVAL 1 HOUR
        GROUP BY s.service_name, s.route
    ),
    byte_baseline AS (
        SELECT s.service_name AS service_name, s.route AS route,
            count() AS baseline_hours, median(coalesce(q.estimated_bytes, 0)) AS median_bytes
        FROM sources s JOIN covered_hour_grid h ON s.service_name = h.service_name
        LEFT JOIN hourly q ON q.service_name = s.service_name AND q.route = s.route AND q.hour = h.hour
        WHERE h.hour >= toStartOfHour(s.first_seen) + INTERVAL 1 HOUR
          AND (coalesce(q.estimated_queries, 0) = 0
           OR coalesce(q.estimated_queries_with_bytes, 0) >= 0.95 * q.estimated_queries)
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
    current_request_attribution AS (
        SELECT service_name, request_id,
            if(uniqExactIf(user_hash, user_hash != '') = 1, max(user_hash), '') AS request_user_hash,
            if(uniqExactIf(rpc_action, rpc_action != '') = 1, max(rpc_action), '') AS request_rpc_action
        FROM spans
        WHERE timestamp >= evaluated_hour AND request_id != ''
        GROUP BY service_name, request_id
    ),
    current_contributions AS (
        SELECT s.service_name AS service_name, s.route AS route,
            coalesce(nullIf(s.user_hash, ''), nullIf(a.request_user_hash, ''), 'unattributed') AS attributed_user_hash,
            coalesce(nullIf(s.rpc_action, ''), nullIf(a.request_rpc_action, ''), 'unattributed') AS attributed_rpc_action,
            sum(s.sample_weight) AS estimated_queries
        FROM spans s
        LEFT ANY JOIN current_request_attribution a ON s.service_name = a.service_name AND s.request_id = a.request_id
        WHERE s.is_db AND s.timestamp >= evaluated_hour
        GROUP BY s.service_name, s.route, attributed_user_hash, attributed_rpc_action
    ),
    current_users AS (
        SELECT service_name, route, attributed_user_hash AS user_hash, sum(estimated_queries) AS queries,
            row_number() OVER (PARTITION BY service_name, route ORDER BY sum(estimated_queries) DESC, attributed_user_hash) AS position_in_route
        FROM current_contributions GROUP BY service_name, route, attributed_user_hash
    ),
    current_actions AS (
        SELECT service_name, route, attributed_rpc_action AS rpc_action, sum(estimated_queries) AS queries,
            row_number() OVER (PARTITION BY service_name, route ORDER BY sum(estimated_queries) DESC, attributed_rpc_action) AS position_in_route
        FROM current_contributions GROUP BY service_name, route, attributed_rpc_action
    ),
    current_user_summary AS (
        SELECT service_name, route,
            arrayStringConcat(groupArrayIf(concat(user_hash, '=', toString(round(queries, 1))), position_in_route <= 3), ', ') AS users,
            count() AS group_count, sumIf(queries, user_hash = 'unattributed') AS unattributed_queries
        FROM current_users GROUP BY service_name, route
    ),
    current_action_summary AS (
        SELECT service_name, route,
            arrayStringConcat(groupArrayIf(concat(rpc_action, '=', toString(round(queries, 1))), position_in_route <= 5), ', ') AS actions,
            count() AS group_count, sumIf(queries, rpc_action = 'unattributed') AS unattributed_queries
        FROM current_actions GROUP BY service_name, route
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
            coalesce(u.users, '') AS user_breakdown, coalesce(u.group_count, 0) AS user_groups,
            coalesce(a.actions, '') AS action_breakdown, coalesce(a.group_count, 0) AS action_groups,
            coalesce(u.unattributed_queries, 0) AS user_unattributed_queries,
            coalesce(a.unattributed_queries, 0) AS action_unattributed_queries,
            greatest(3 * coalesce(b.median_queries, 0), 2000) AS threshold_queries,
            greatest(3 * coalesce(bb.median_bytes, 0), 10000000) AS threshold_bytes
        FROM sources s
        LEFT JOIN current_service cs ON s.service_name = cs.service_name
        LEFT JOIN baseline b ON s.service_name = b.service_name AND s.route = b.route
        LEFT JOIN byte_baseline bb ON s.service_name = bb.service_name AND s.route = bb.route
        LEFT JOIN current_hour c ON s.service_name = c.service_name AND s.route = c.route
        LEFT JOIN current_user_summary u ON s.service_name = u.service_name AND s.route = u.route
        LEFT JOIN current_action_summary a ON s.service_name = a.service_name AND s.route = a.route
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
        ' | users top3/', toString(user_groups), ': ', if(user_breakdown = '', 'no observed query', user_breakdown),
        ' | RPC actions top5/', toString(action_groups), ': ', if(action_breakdown = '', 'no observed query', action_breakdown),
        ' | unattributed user/action queries=', toString(user_unattributed_queries), '/', toString(action_unattributed_queries),
        if(NOT current_service_observed, ' NO CURRENT TELEMETRY; evaluation suppressed', if(covered_hours < 24, ' WARMUP; monthly 50% and heartbeat remain', '')),
        ' | route-local warmup; per-span 1/sample_rate; legacy rate=0.1; bytes require 95% weighted coverage; not provider egress') AS row_source,
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
