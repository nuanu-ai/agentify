-- Worker liveness and queue pressure using application-owned tables only.
with heartbeat as (
  select
    service,
    count(*) filter (where heartbeat_at >= now() - interval '30 seconds') as live_workers,
    max(heartbeat_at) as latest_heartbeat_at,
    bool_or(
      heartbeat_at >= now() - interval '30 seconds'
      and metadata @> '{"ready": true}'::jsonb
    ) as ready_worker,
    bool_or(
      heartbeat_at >= now() - interval '30 seconds'
      and metadata @> '{"queue_connected": true}'::jsonb
    ) as queue_connected,
    bool_or(
      heartbeat_at >= now() - interval '30 seconds'
      and metadata @> '{"database_connected": true}'::jsonb
    ) as database_connected
  from worker_heartbeats
  group by service
), queue as (
  select
    count(*) filter (where status in ('accepted', 'queued')) as queued,
    min(accepted_at) filter (where status in ('accepted', 'queued')) as oldest_queued_at,
    count(*) filter (where status = 'running') as running,
    count(*) filter (
      where status = 'running' and worker_heartbeat_at < now() - interval '30 seconds'
    ) as stale_running
  from scans
)
select
  coalesce(h.service, 'scanner-worker') as service,
  coalesce(h.live_workers, 0) as live_workers,
  h.latest_heartbeat_at,
  coalesce(h.ready_worker, false) as ready_worker,
  coalesce(h.queue_connected, false) as queue_connected,
  coalesce(h.database_connected, false) as database_connected,
  q.queued,
  q.oldest_queued_at,
  q.running,
  q.stale_running
from queue q
left join heartbeat h on h.service = 'scanner-worker';
