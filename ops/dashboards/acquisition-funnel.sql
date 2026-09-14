-- PII-minimized acquisition funnel. Cells with fewer than five verified leads are suppressed.
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
  from analytics_events ae
  join sessions s on s.id = ae.session_id
  where ae.occurred_at >= current_date - interval '90 days'
),
funnel as (
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
from funnel
order by event_date desc, segment, landing_variant;
