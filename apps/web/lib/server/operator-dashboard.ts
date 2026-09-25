import { getServerConfig } from "./config";
import { getDatabase } from "./database";

/**
 * What the operator page reads, straight from the scanner's tables. Target
 * hostnames appear, and no submitted URL, lead or session identifier, contact
 * field, token or raw browser evidence does. They are queries here rather
 * than views in the database, because a database built from the migrations
 * alone has to answer this page too.
 */
const OVERVIEW = `
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
    (select coalesce(sum(usage_usd), 0)::numeric(12, 6) from public.browser_observations where budget_day = current_date) as browser_usage_usd_today`;

const DAILY_FUNNEL = `
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
  order by days.day`;

const RECENT_SCANS = `
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

export type OperatorOverview = {
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

export type OperatorDailyFunnel = {
  day: string;
  visitors: number;
  landingViews: number;
  scans: number;
  completedScans: number;
  verifiedRegistrations: number;
  shares: number;
};

export type OperatorRecentScan = {
  scanId: string;
  targetHost: string;
  segment: string;
  status: string;
  score: number | null;
  coverage: number | null;
  level: string | null;
  cacheHit: boolean;
  acceptedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  browserStatus: string | null;
};

export type OperatorSelfScan = {
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
  daily: OperatorDailyFunnel[];
  recentScans: OperatorRecentScan[];
  selfScan: OperatorSelfScan | null;
};

export async function getOperatorDashboard(): Promise<OperatorDashboard> {
  const { pool } = getDatabase();
  const [overviewResult, dailyResult, scansResult, selfResult] = await Promise.all([
    pool.query(OVERVIEW),
    pool.query(DAILY_FUNNEL),
    pool.query(RECENT_SCANS),
    pool.query(SELF_SCAN),
  ]);

  const overview = overviewResult.rows[0];
  if (!overview) throw new Error("operator_dashboard_overview_missing");

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
      challengePasses1h: asNumber(overview.challenge_passes_24h),
      browserUsageUsdToday: asNumber(overview.browser_usage_usd_today),
    },
    daily: dailyResult.rows.map((row) => ({
      day: asIso(row.day).slice(0, 10),
      visitors: asNumber(row.visitors),
      landingViews: asNumber(row.landing_views),
      scans: asNumber(row.scans),
      completedScans: asNumber(row.completed_scans),
      verifiedRegistrations: asNumber(row.verified_registrations),
      shares: asNumber(row.shares),
    })),
    recentScans: scansResult.rows.map((row) => ({
      scanId: String(row.scan_id),
      targetHost: String(row.target_host),
      segment: String(row.segment),
      status: String(row.status),
      score: asNullableNumber(row.score),
      coverage: asNullableNumber(row.coverage),
      level: row.level === null ? null : String(row.level),
      cacheHit: Boolean(row.cache_hit),
      acceptedAt: asIso(row.accepted_at),
      finishedAt: row.finished_at === null ? null : asIso(row.finished_at),
      durationSeconds: asNullableNumber(row.duration_seconds),
      browserStatus: row.browser_status === null ? null : String(row.browser_status),
    })),
    selfScan: selfResult.rows[0]
      ? {
          scanId: String(selfResult.rows[0].scan_id),
          targetHost: String(selfResult.rows[0].target_host),
          segment: String(selfResult.rows[0].segment),
          status: String(selfResult.rows[0].status),
          score: asNullableNumber(selfResult.rows[0].score),
          coverage: asNullableNumber(selfResult.rows[0].coverage),
          level: selfResult.rows[0].level === null ? null : String(selfResult.rows[0].level),
          acceptedAt: asIso(selfResult.rows[0].accepted_at),
          finishedAt:
            selfResult.rows[0].finished_at === null ? null : asIso(selfResult.rows[0].finished_at),
          substantiveHtmlStatus:
            selfResult.rows[0].substantive_html_status === null
              ? null
              : String(selfResult.rows[0].substantive_html_status),
          agentUserAgentStatus:
            selfResult.rows[0].agent_user_agent_status === null
              ? null
              : String(selfResult.rows[0].agent_user_agent_status),
          browserStatus:
            selfResult.rows[0].browser_status === null
              ? null
              : String(selfResult.rows[0].browser_status),
        }
      : null,
  };
}
