SELECT if(count() = 0, NULL, argMax(toFloat(properties.monthly_budget_ratio), timestamp)) AS value
FROM events
WHERE event = 'mikka_ops_snapshot'
  AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 30 DAY
  AND properties.monthly_budget_ratio IS NOT NULL