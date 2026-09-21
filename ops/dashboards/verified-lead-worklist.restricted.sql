-- RESTRICTED: concierge/support role only. Still excludes email ciphertext/hashes and free text.
select
  l.id as lead_id,
  s.id as scan_id,
  s.target_host,
  s.segment,
  l.role,
  l.verified_at,
  s.score,
  s.coverage,
  s.level,
  s.finished_at,
  exists (
    select 1 from scan_shares sh
    where sh.scan_id = s.id and sh.status = 'published'
  ) as public_share_live,
  exists (
    select 1 from payment_signals ps
    where ps.lead_id = l.id and ps.status = 'attached'
  ) as card_signal_attached
from leads l
join lead_scans ls on ls.lead_id = l.id
join scans s on s.id = ls.scan_id
left join waitlist_entries w on w.lead_id = l.id and w.scan_id = s.id
where l.verified_at is not null
order by l.verified_at;
