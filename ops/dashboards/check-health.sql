-- Check distribution and safe error-code aggregates. No evidence payloads.
select
  date_trunc('day', s.accepted_at) as day,
  s.segment,
  sc.check_id,
  sc.status,
  coalesce(sc.error_code, 'none') as error_code,
  count(*) as results,
  round(avg(sc.duration_ms)::numeric, 1) as avg_duration_ms,
  percentile_cont(0.95) within group (order by sc.duration_ms)
    filter (where sc.duration_ms is not null) as p95_duration_ms
from scan_checks sc
join scans s on s.id = sc.scan_id
where s.accepted_at >= current_date - interval '30 days'
group by 1, 2, 3, 4, 5
order by 1 desc, 2, 3, 4;
