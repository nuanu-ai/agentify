-- Aggregate platform/WAF distribution. Small target populations are suppressed.
with grouped as (
  select
    date_trunc('month', s.finished_at) as month,
    s.segment,
    sf.platform,
    sf.platform_confidence,
    count(distinct s.target_hash) as unique_targets,
    count(*) as scans
  from scan_fingerprints sf
  join scans s on s.id = sf.scan_id
  where s.finished_at >= current_date - interval '13 months'
    and s.status in ('completed', 'partial')
    and s.coverage >= 0.700
  group by 1, 2, 3, 4
)
select month, segment, platform, platform_confidence, unique_targets, scans
from grouped
where unique_targets >= 5
order by month desc, segment, unique_targets desc;
