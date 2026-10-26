import { getServerConfig } from "./config";
import { getDatabase } from "./database";
import {
  OPERATIONAL_SIGNALS_QUERY,
  type OperationalSignalRow,
  WORKER_HEARTBEAT_QUERY,
  type WorkerHeartbeatRow,
} from "./worker-health";

/**
 * What the operator page reads, straight from the scanner's tables. Target
 * hostnames appear, and no submitted URL, lead or session identifier, contact
 * field, token or raw browser evidence does. They are queries here rather
 * than views in the database, because a database built from the migrations
 * alone has to answer this page too.
 *
 * The analytics events hold only visitors who allowed optional measurement,
 * so a number read from them counts those visitors and no others, and the page
 * says so beside it. Scans and registrations are read from their own records.
 * Days are UTC days, as the browser budget's are, whatever the zone of the
 * database session or of this process.
 * A copy of a person's data that no try confirmed as taken by the mail
 * service, or that was too large to email, is counted until a later copy to
 * the same address is mailed or the request is forgotten after thirty days.
 */
const UNANSWERED_COPY = `failed.state = 'failed' and not exists (
      select 1 from public.data_copy_requests later
      where later.email_lookup_hash = failed.email_lookup_hash
        and later.state = 'sent' and later.requested_at > failed.requested_at)`;

const OVERVIEW = `
  select
    (select count(*)::bigint from public.sessions) as visitors_total,
    (select count(*)::bigint from public.sessions where created_at >= now() - interval '30 days') as visitors_30d,
    (select count(*)::bigint from public.analytics_events where name = 'landing_view' and occurred_at >= now() - interval '30 days') as landing_views_30d,
    (select count(*)::bigint from public.scans) as scans_total,
    (select count(*)::bigint from public.scans where accepted_at >= now() - interval '30 days') as scans_30d,
    (select count(*)::bigint from public.scans where accepted_at >= now() - interval '30 days' and status in ('completed', 'partial')) as completed_scans_30d,
    (select count(distinct target_hash)::bigint from public.scans where accepted_at >= now() - interval '30 days') as unique_sites_30d,
    (select count(*)::bigint from public.waitlist_entries where created_at >= now() - interval '30 days') as verified_registrations_30d,
    (select count(*)::bigint from public.analytics_events where name = 'result_shared' and occurred_at >= now() - interval '30 days') as shares_30d,
    (select count(*)::bigint from public.scans where accepted_at >= now() - interval '24 hours') as accepted_requests_24h,
    (select count(*)::bigint from public.rate_limit_events where kind = 'scan_ip_hour' and challenge_passed and occurred_at >= now() - interval '1 hour') as challenge_passes_1h,
    (select coalesce(sum(usage_usd), 0)::numeric(12, 6) from public.browser_observations where budget_day = (now() at time zone 'UTC')::date) as browser_usage_usd_today,
    (select count(*)::bigint from public.data_copy_requests failed where ${UNANSWERED_COPY}) as data_copies_unconfirmed,
    (select min(requested_at) from public.data_copy_requests failed where ${UNANSWERED_COPY}) as data_copies_oldest_at`;

const DAILY = `
  with today as (
    select (now() at time zone 'UTC')::date as day
  ), days as (
    select generate_series(today.day - 29, today.day, interval '1 day')::date as day from today
  ), landings as (
    select (occurred_at at time zone 'UTC')::date as day, count(*)::bigint as landing_views
    from public.analytics_events, today
    where name = 'landing_view' and occurred_at >= (today.day - 29)::timestamp at time zone 'UTC'
    group by 1
  ), scan_totals as (
    select (accepted_at at time zone 'UTC')::date as day, count(*)::bigint as scans
    from public.scans, today
    where accepted_at >= (today.day - 29)::timestamp at time zone 'UTC'
    group by 1
  )
  select
    days.day::text as day,
    coalesce(landings.landing_views, 0)::bigint as landing_views,
    coalesce(scan_totals.scans, 0)::bigint as scans
  from days
  left join landings using (day)
  left join scan_totals using (day)
  order by days.day`;

const RECENT_SCANS = `
  select s.id as scan_id, s.target_host, s.segment, s.status, s.score, s.coverage, s.accepted_at
  from public.scans s
  order by s.accepted_at desc
  limit 50`;

const SELF_SCAN = `
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
  limit 1`;

const asNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const asNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : asNumber(value);

const asIso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

const asNullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

type OperatorOverview = {
  visitorsTotal: number;
  visitors30d: number;
  landingViews30d: number;
  scansTotal: number;
  scans30d: number;
  completedScans30d: number;
  uniqueSites30d: number;
  verifiedRegistrations30d: number;
  shares30d: number;
  acceptedRequests24h: number;
  challengePasses1h: number;
  browserUsageUsdToday: number;
};

export type OperatorDay = {
  day: string;
  landingViews: number;
  scans: number;
};

type OperatorRecentScan = {
  scanId: string;
  targetHost: string;
  segment: string;
  status: string;
  score: number | null;
  coverage: number | null;
  acceptedAt: string;
};

type OperatorSelfScan = {
  scanId: string;
  targetHost: string;
  segment: string;
  status: string;
  score: number | null;
  coverage: number | null;
  level: string | null;
  acceptedAt: string;
  finishedAt: string | null;
  substantiveHtmlStatus: string | null;
  agentUserAgentStatus: string | null;
  browserStatus: string | null;
};

export type OperatorDashboard = {
  generatedAt: string;
  turnstileEnforced: boolean;
  overview: OperatorOverview;
  /** Data copies no try confirmed, and when the oldest of them was asked for. */
  dataCopies: { unconfirmed: number; oldestAt: string | null };
  /** The last thirty days, oldest first; the last is today, read part of the way through. */
  daily: OperatorDay[];
  recentScans: OperatorRecentScan[];
  selfScan: OperatorSelfScan | null;
  /** What the health check reads, for the page to judge by the health check's own rules. */
  worker: { heartbeat: WorkerHeartbeatRow | null; signals: OperationalSignalRow };
};

export async function getOperatorDashboard(): Promise<OperatorDashboard> {
  const { pool } = getDatabase();
  const [overviewResult, dailyResult, scansResult, selfResult, heartbeatResult, signalsResult] =
    await Promise.all([
      pool.query(OVERVIEW),
      pool.query(DAILY),
      pool.query(RECENT_SCANS),
      pool.query(SELF_SCAN),
      pool.query<WorkerHeartbeatRow>(WORKER_HEARTBEAT_QUERY),
      pool.query<OperationalSignalRow>(OPERATIONAL_SIGNALS_QUERY),
    ]);

  const overview = overviewResult.rows[0];
  if (!overview) throw new Error("operator_dashboard_overview_missing");
  const signals = signalsResult.rows[0];
  if (!signals) throw new Error("operator_dashboard_signals_missing");
  const heartbeat = heartbeatResult.rows[0];
  const self = selfResult.rows[0];

  return {
    generatedAt: new Date().toISOString(),
    turnstileEnforced: getServerConfig().TURNSTILE_ENFORCED,
    overview: {
      visitorsTotal: asNumber(overview.visitors_total),
      visitors30d: asNumber(overview.visitors_30d),
      landingViews30d: asNumber(overview.landing_views_30d),
      scansTotal: asNumber(overview.scans_total),
      scans30d: asNumber(overview.scans_30d),
      completedScans30d: asNumber(overview.completed_scans_30d),
      uniqueSites30d: asNumber(overview.unique_sites_30d),
      verifiedRegistrations30d: asNumber(overview.verified_registrations_30d),
      shares30d: asNumber(overview.shares_30d),
      acceptedRequests24h: asNumber(overview.accepted_requests_24h),
      challengePasses1h: asNumber(overview.challenge_passes_1h),
      browserUsageUsdToday: asNumber(overview.browser_usage_usd_today),
    },
    dataCopies: {
      unconfirmed: asNumber(overview.data_copies_unconfirmed),
      oldestAt:
        overview.data_copies_oldest_at === null ? null : asIso(overview.data_copies_oldest_at),
    },
    daily: dailyResult.rows.map((row) => ({
      day: String(row.day),
      landingViews: asNumber(row.landing_views),
      scans: asNumber(row.scans),
    })),
    recentScans: scansResult.rows.map((row) => ({
      scanId: String(row.scan_id),
      targetHost: String(row.target_host),
      segment: String(row.segment),
      status: String(row.status),
      score: asNullableNumber(row.score),
      coverage: asNullableNumber(row.coverage),
      acceptedAt: asIso(row.accepted_at),
    })),
    selfScan: self
      ? {
          scanId: String(self.scan_id),
          targetHost: String(self.target_host),
          segment: String(self.segment),
          status: String(self.status),
          score: asNullableNumber(self.score),
          coverage: asNullableNumber(self.coverage),
          level: asNullableString(self.level),
          acceptedAt: asIso(self.accepted_at),
          finishedAt: self.finished_at === null ? null : asIso(self.finished_at),
          substantiveHtmlStatus: asNullableString(self.substantive_html_status),
          agentUserAgentStatus: asNullableString(self.agent_user_agent_status),
          browserStatus: asNullableString(self.browser_status),
        }
      : null,
    worker: {
      heartbeat: heartbeat
        ? { heartbeat_at: asIso(heartbeat.heartbeat_at), metadata: heartbeat.metadata }
        : null,
      signals,
    },
  };
}
