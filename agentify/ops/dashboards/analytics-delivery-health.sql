select
  destination,
  status,
  count(*) as rows,
  max(attempts) as max_attempts,
  min(next_attempt_at) filter (where status = 'pending') as oldest_pending_at,
  count(*) filter (where status = 'dead_letter') as dead_letter_rows
from delivery_outbox
group by destination, status
order by destination, status;
