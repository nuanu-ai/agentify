# Shop job ownership

The dashboard keeps accepted shop work in `dashboard_shop_jobs`. Four workers
per dashboard process claim queued rows with `FOR UPDATE SKIP LOCKED`. The
existing unique index permits one queued or running job per seller, so a slow
shop occupies one worker while other sellers continue. During a rolling release,
each process can run four jobs, with the same seller exclusion across processes.

A worker holds a PostgreSQL session advisory lock for the claimed job on a
dedicated connection from a separate pool. That pool has one slot per worker;
page reads, enqueue and interruption recovery use the dashboard's page pool.
Progress and completion use the ownership connection, with writes
serialized within the job. A replacement process probes the lock before recording
an interrupted result and leaves a live owner's job alone. The old owner can
finish normally. Closing or losing the ownership connection releases its lock;
recovery records the partial result as stopped and does not replay publication.
The runner checks its ownership before continuing work. A publication already in
flight when ownership is lost can have an unknown outcome.

Idle workers poll queued rows once a second. Recovery runs on startup and every
thirty seconds after the preceding reconciliation finishes. It checks connections for a missing check or a newly saved rate. This pass also recovers abandoned jobs while the process stays up.
Graceful shutdown waits for active walks while the gateway remains available,
then releases the ownership connections and closes their pool.

The recovery pass still reads every connected shop every thirty seconds. Replacing
that pass with one query selecting the shops that need work is tracked in
`00-open-questions.md` for growth in the number of shops.

This uses the existing queue table and PostgreSQL locking. Adding pg-boss here
would require another queue representation and coordination with the transactions
that save a connection or exchange rate. An expiring
lease cannot distinguish a dead worker from one that is slow or suspended. A
process-local mutex cannot exclude a second dashboard process. Session ownership
avoids those additions without changing the SDK or merchant contracts.
