-- Run as a trusted migration/admin owner. Grant aggregate role access to this schema only.
create schema if not exists metabase;
revoke all on schema metabase from public;

create or replace view metabase.scan_health with (security_barrier = true) as
select
  date_trunc('hour', accepted_at) as hour,
  segment,
  count(*) as accepted,
  count(*) filter (where status in ('completed', 'partial')) as completed_or_partial,
  count(*) filter (where status = 'failed') as failed,
  round(count(*) filter (where status = 'failed')::numeric / nullif(count(*), 0), 4) as failure_rate,
  round((avg(coverage) filter (where status in ('completed', 'partial')))::numeric, 3) as avg_coverage,
  percentile_cont(0.95) within group (order by extract(epoch from (finished_at - accepted_at)))
    filter (where finished_at is not null) as p95_scan_seconds,
  percentile_cont(0.95) within group (order by extract(epoch from (started_at - accepted_at)))
    filter (where started_at is not null) as p95_queue_seconds
from public.scans
where accepted_at >= now() - interval '90 days'
group by 1, 2;

create or replace view metabase.check_health with (security_barrier = true) as
select
  date_trunc('day', s.accepted_at) as day,
  s.segment,
  sc.check_id,
  sc.status,
  coalesce(sc.error_code, 'none') as error_code,
  count(*) as results,
  round(avg(sc.duration_ms)::numeric, 1) as avg_duration_ms
from public.scan_checks sc
join public.scans s on s.id = sc.scan_id
where s.accepted_at >= current_date - interval '90 days'
group by 1, 2, 3, 4, 5;

create or replace view metabase.delivery_health with (security_barrier = true) as
select
  destination,
  status,
  count(*) as rows,
  max(attempts) as max_attempts,
  min(next_attempt_at) filter (where status = 'pending') as oldest_pending_at,
  count(*) filter (where status = 'dead_letter') as dead_letter_rows
from public.delivery_outbox
group by 1, 2;

create or replace view metabase.worker_queue_health with (security_barrier = true) as
with queue as (
  select
    count(*) filter (where status in ('accepted', 'queued')) as queued,
    min(accepted_at) filter (where status in ('accepted', 'queued')) as oldest_queued_at,
    count(*) filter (where status = 'running') as running,
    count(*) filter (
      where status = 'running' and worker_heartbeat_at < now() - interval '30 seconds'
    ) as stale_running
  from public.scans
), heartbeat as (
  select
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
  from public.worker_heartbeats
  where service = 'scanner-worker'
)
select
  queue.queued,
  queue.oldest_queued_at,
  queue.running,
  queue.stale_running,
  heartbeat.latest_heartbeat_at,
  coalesce(heartbeat.ready_worker, false) as ready_worker,
  coalesce(heartbeat.queue_connected, false) as queue_connected,
  coalesce(heartbeat.database_connected, false) as database_connected
from queue cross join heartbeat;

create or replace view metabase.acquisition_funnel with (security_barrier = true) as
with business_events as (
  select
    ae.occurred_at::date as event_date,
    ae.segment,
    ae.landing_variant,
    s.first_utm_campaign as utm_campaign,
    s.first_utm_content as utm_content,
    s.geo_country as country,
    ae.name,
    ae.session_id,
    ae.scan_id,
    ae.lead_id
  from public.analytics_events ae
  join public.sessions s on s.id = ae.session_id
  where ae.occurred_at >= current_date - interval '90 days'
), funnel as (
  select
    event_date,
    segment,
    landing_variant,
    utm_campaign,
    utm_content,
    country,
    count(distinct (session_id, landing_variant, event_date)) filter (where name = 'landing_view') as landing_views,
    count(distinct scan_id) filter (where name = 'scan_started') as scans_started,
    count(distinct scan_id) filter (where name = 'scan_completed') as scans_completed,
    count(distinct (lead_id, scan_id)) filter (where name = 'registration_completed') as verified_registrations,
    count(distinct lead_id) filter (where name = 'card_attached') as card_signals
  from business_events
  group by 1, 2, 3, 4, 5, 6
)
select
  event_date,
  segment,
  landing_variant,
  case when verified_registrations >= 5 then utm_campaign end as utm_campaign,
  case when verified_registrations >= 5 then utm_content end as utm_content,
  case when verified_registrations >= 5 then country end as country,
  landing_views,
  scans_started,
  scans_completed,
  verified_registrations,
  card_signals,
  round(scans_started::numeric / nullif(landing_views, 0), 4) as scan_start_rate,
  round(verified_registrations::numeric / nullif(scans_started, 0), 4) as scan_to_verified_rate,
  round(card_signals::numeric / nullif(verified_registrations, 0), 4) as card_signal_rate,
  verified_registrations >= 5 as breakdown_visible
from funnel;

create or replace view metabase.fingerprint_summary with (security_barrier = true) as
with grouped as (
  select
    date_trunc('month', s.finished_at) as month,
    s.segment,
    sf.platform,
    sf.platform_confidence,
    count(distinct s.target_hash) as unique_targets,
    count(*) as scans
  from public.scan_fingerprints sf
  join public.scans s on s.id = sf.scan_id
  where s.finished_at >= current_date - interval '13 months'
    and s.status in ('completed', 'partial')
    and s.coverage >= 0.700
  group by 1, 2, 3, 4
)
select month, segment, platform, platform_confidence, unique_targets, scans
from grouped
where unique_targets >= 5;

-- This view briefly shipped with the registration column in two ordinal
-- positions. CREATE OR REPLACE must retain an existing column order, so choose
-- the matching definition instead of replacing the object and losing its OID,
-- owner, grants, grantors, grant options, or dependency graph.
do $privacy_retention_audit_view$
declare
  view_columns text[];
  legacy_columns constant text[] := array[
    'overdue_verification_tokens',
    'overdue_unverified_leads',
    'expired_active_report_sessions',
    'active_public_shares',
    'attached_card_signals',
    'analytics_dead_letters'
  ];
  registration_second_columns constant text[] := array[
    'overdue_verification_tokens',
    'overdue_registration_intents',
    'overdue_unverified_leads',
    'expired_active_report_sessions',
    'active_public_shares',
    'attached_card_signals',
    'analytics_dead_letters'
  ];
  registration_last_columns constant text[] := array[
    'overdue_verification_tokens',
    'overdue_unverified_leads',
    'expired_active_report_sessions',
    'active_public_shares',
    'attached_card_signals',
    'analytics_dead_letters',
    'overdue_registration_intents'
  ];
begin
  select array_agg(attribute.attname::text order by attribute.attnum)
  into view_columns
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_attribute attribute on attribute.attrelid = relation.oid
  where namespace.nspname = 'metabase'
    and relation.relname = 'privacy_retention_audit'
    and relation.relkind = 'v'
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if view_columns is null
    or view_columns = legacy_columns
    or view_columns = registration_last_columns
  then
    execute $view$
      create or replace view metabase.privacy_retention_audit with (security_barrier = true) as
      select
        (select count(*) from public.verification_tokens where coalesce(used_at, expires_at) < now() - interval '7 days') as overdue_verification_tokens,
        (select count(*) from public.leads where verified_at is null and anonymized_at is null and created_at < now() - interval '30 days') as overdue_unverified_leads,
        (select count(*) from public.report_sessions where expires_at < now() and revoked_at is null) as expired_active_report_sessions,
        (select count(*) from public.scan_shares where status = 'published') as active_public_shares,
        (select count(*) from public.payment_signals where status = 'attached') as attached_card_signals,
        (select count(*) from public.delivery_outbox where status = 'dead_letter') as analytics_dead_letters,
        (select count(*) from public.registration_intents where coalesce(consumed_at, expires_at) < now() - interval '7 days') as overdue_registration_intents
    $view$;
  elsif view_columns = registration_second_columns then
    execute $view$
      create or replace view metabase.privacy_retention_audit with (security_barrier = true) as
      select
        (select count(*) from public.verification_tokens where coalesce(used_at, expires_at) < now() - interval '7 days') as overdue_verification_tokens,
        (select count(*) from public.registration_intents where coalesce(consumed_at, expires_at) < now() - interval '7 days') as overdue_registration_intents,
        (select count(*) from public.leads where verified_at is null and anonymized_at is null and created_at < now() - interval '30 days') as overdue_unverified_leads,
        (select count(*) from public.report_sessions where expires_at < now() and revoked_at is null) as expired_active_report_sessions,
        (select count(*) from public.scan_shares where status = 'published') as active_public_shares,
        (select count(*) from public.payment_signals where status = 'attached') as attached_card_signals,
        (select count(*) from public.delivery_outbox where status = 'dead_letter') as analytics_dead_letters
    $view$;
  else
    raise exception 'unexpected metabase.privacy_retention_audit columns: %', view_columns;
  end if;
end
$privacy_retention_audit_view$;

create or replace view metabase.browser_observation_health with (security_barrier = true) as
select
  date_trunc('hour', queued_at) as hour,
  observation_version,
  status,
  coalesce(failure_code, 'none') as failure_code,
  count(*)::bigint as observations,
  percentile_cont(0.50) within group (order by duration_ms)
    filter (where duration_ms is not null) as duration_p50_ms,
  percentile_cont(0.95) within group (order by duration_ms)
    filter (where duration_ms is not null) as duration_p95_ms,
  sum(coalesce(request_count, 0))::bigint as requests,
  sum(coalesce(transferred_bytes, 0))::bigint as transferred_bytes,
  sum(coalesce(usage_usd, 0))::numeric(12, 6) as usage_usd
from public.browser_observations
group by 1, 2, 3, 4;

create or replace view metabase.browser_observation_queue_health with (security_barrier = true) as
select
  status,
  count(*)::bigint as rows,
  min(queued_at) as oldest_queued_at,
  count(*) filter (
    where status in ('starting', 'running')
      and (lease_expires_at is null or lease_expires_at < now())
  )::bigint as stale_or_unknown_rows
from public.browser_observations
where status in ('queued', 'starting', 'running')
group by status;

create or replace view metabase.browser_observation_budget_health with (security_barrier = true) as
select
  budget.budget_day,
  budget.usage_usd::numeric(12, 6) as reconciled_usage_usd,
  budget.reserved_usd::numeric(12, 6) as reserved_usage_usd,
  (budget.usage_usd + budget.reserved_usd)::numeric(12, 6) as breaker_usage_usd,
  count(observation.id) filter (
    where observation.budget_reserved_usd > 0
  )::bigint as outstanding_reservations,
  budget.updated_at,
  count(observation.id) filter (
    where observation.usage_reconciled_at is null
      and observation.status in ('completed', 'partial', 'blocked', 'failed')
  )::bigint as pending_usage_reconciliations
from public.browser_observation_budget_days budget
left join public.browser_observations observation
  on observation.budget_day = budget.budget_day
group by budget.budget_day, budget.usage_usd, budget.reserved_usd, budget.updated_at;

create or replace view metabase.browser_observation_findings with (security_barrier = true) as
select
  finding_id,
  status,
  count(*)::bigint as findings
from public.browser_observation_findings
group by finding_id, status;

-- Restricted operator views. They intentionally expose target hostnames but no
-- submitted URLs, lead/session identifiers, contact fields, tokens, or raw
-- browser evidence. Access is granted only to agentify_dashboard below.
create or replace view metabase.operator_overview with (security_barrier = true) as
select
  (select count(*)::bigint from public.sessions) as visitors_total,
  (select count(*)::bigint from public.sessions where created_at >= now() - interval '30 days') as visitors_30d,
  (select count(*)::bigint from public.analytics_events where name = 'landing_view' and occurred_at >= now() - interval '30 days') as landing_views_30d,
  (select count(*)::bigint from public.scans) as scans_total,
  (select count(*)::bigint from public.scans where accepted_at >= now() - interval '30 days') as scans_30d,
  (select count(*)::bigint from public.scans where accepted_at >= now() - interval '30 days' and status in ('completed', 'partial')) as completed_scans_30d,
  (select count(distinct target_hash)::bigint from public.scans where accepted_at >= now() - interval '30 days') as unique_sites_30d,
  (select count(*)::bigint from public.analytics_events where name = 'registration_completed' and occurred_at >= now() - interval '30 days') as verified_registrations_30d,
  (select count(*)::bigint from public.analytics_events where name = 'result_shared' and occurred_at >= now() - interval '30 days') as shares_30d,
  (select count(*)::bigint from public.scans where accepted_at >= now() - interval '24 hours') as accepted_requests_24h,
  (select count(*)::bigint from public.rate_limit_events where kind = 'scan_ip_hour' and challenge_passed and occurred_at >= now() - interval '1 hour') as challenge_passes_24h,
  (select coalesce(sum(usage_usd), 0)::numeric(12, 6) from public.browser_observations where budget_day = current_date) as browser_usage_usd_today;

create or replace view metabase.operator_daily_funnel with (security_barrier = true) as
with days as (
  select generate_series(current_date - interval '29 days', current_date, interval '1 day')::date as day
), visitors as (
  select created_at::date as day, count(*)::bigint as visitors
  from public.sessions
  where created_at >= current_date - interval '29 days'
  group by 1
), landings as (
  select occurred_at::date as day, count(*)::bigint as landing_views
  from public.analytics_events
  where name = 'landing_view' and occurred_at >= current_date - interval '29 days'
  group by 1
), scan_totals as (
  select
    accepted_at::date as day,
    count(*)::bigint as scans,
    count(*) filter (where status in ('completed', 'partial'))::bigint as completed_scans
  from public.scans
  where accepted_at >= current_date - interval '29 days'
  group by 1
), registrations as (
  select occurred_at::date as day, count(*)::bigint as verified_registrations
  from public.analytics_events
  where name = 'registration_completed' and occurred_at >= current_date - interval '29 days'
  group by 1
), shares as (
  select occurred_at::date as day, count(*)::bigint as shares
  from public.analytics_events
  where name = 'result_shared' and occurred_at >= current_date - interval '29 days'
  group by 1
)
select
  days.day,
  coalesce(visitors.visitors, 0)::bigint as visitors,
  coalesce(landings.landing_views, 0)::bigint as landing_views,
  coalesce(scan_totals.scans, 0)::bigint as scans,
  coalesce(scan_totals.completed_scans, 0)::bigint as completed_scans,
  coalesce(registrations.verified_registrations, 0)::bigint as verified_registrations,
  coalesce(shares.shares, 0)::bigint as shares
from days
left join visitors using (day)
left join landings using (day)
left join scan_totals using (day)
left join registrations using (day)
left join shares using (day)
order by days.day;

create or replace view metabase.operator_recent_scans with (security_barrier = true) as
select
  s.id as scan_id,
  s.target_host,
  s.segment,
  s.status,
  s.score,
  s.coverage,
  s.level,
  s.cache_hit,
  s.accepted_at,
  s.finished_at,
  case
    when s.finished_at is not null then extract(epoch from (s.finished_at - s.accepted_at))::integer
  end as duration_seconds,
  observation.status as browser_status
from public.scans s
left join lateral (
  select bo.status
  from public.browser_observations bo
  where bo.scan_id = s.id
  order by bo.queued_at desc
  limit 1
) observation on true
order by s.accepted_at desc
limit 100;

create or replace view metabase.operator_self_scan with (security_barrier = true) as
select
  s.id as scan_id,
  s.target_host,
  s.segment,
  s.status,
  s.score,
  s.coverage,
  s.level,
  s.accepted_at,
  s.finished_at,
  c12.status as substantive_html_status,
  c13.status as agent_user_agent_status,
  observation.status as browser_status
from public.scans s
left join public.scan_checks c12 on c12.scan_id = s.id and c12.check_id = 12
left join public.scan_checks c13 on c13.scan_id = s.id and c13.check_id = 13
left join lateral (
  select bo.status
  from public.browser_observations bo
  where bo.scan_id = s.id
  order by bo.queued_at desc
  limit 1
) observation on true
where s.target_host in ('agentify.ad', 'www.agentify.ad')
order by s.accepted_at desc
limit 1;

revoke all on all tables in schema metabase from public;

do $dashboard_grants$
begin
  if exists (select 1 from pg_roles where rolname = 'agentify_dashboard') then
    grant usage on schema metabase to agentify_dashboard;
    grant select on metabase.operator_overview to agentify_dashboard;
    grant select on metabase.operator_daily_funnel to agentify_dashboard;
    grant select on metabase.operator_recent_scans to agentify_dashboard;
    grant select on metabase.operator_self_scan to agentify_dashboard;
  end if;
end
$dashboard_grants$;
