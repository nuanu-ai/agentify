-- Aggregate scanner SLO and failure health. No target, lead, session, or token fields.
select
  date_trunc('hour', accepted_at) as hour,
  segment,
  count(*) as accepted,
  count(*) filter (where status in ('completed', 'partial')) as completed_or_partial,
  count(*) filter (where status = 'failed') as failed,
  round(
    count(*) filter (where status = 'failed')::numeric / nullif(count(*), 0),
    4
  ) as failure_rate,
  round((avg(coverage) filter (where status in ('completed', 'partial')))::numeric, 3) as avg_coverage,
  percentile_cont(0.95) within group (
    order by extract(epoch from (finished_at - accepted_at))
  ) filter (where finished_at is not null) as p95_scan_seconds,
  percentile_cont(0.95) within group (
    order by extract(epoch from (started_at - accepted_at))
  ) filter (where started_at is not null) as p95_queue_seconds,
  count(*) filter (
    where status in ('accepted', 'queued') and accepted_at < now() - interval '10 seconds'
  ) as queued_over_10s,
  count(*) filter (
    where status = 'running' and worker_heartbeat_at < now() - interval '30 seconds'
  ) as stale_running
from scans
where accepted_at >= now() - interval '7 days'
group by 1, 2
order by 1 desc, 2;
