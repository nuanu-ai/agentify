import { getServerConfig } from "./config";
import { getDashboardDatabase } from "./dashboard-database";

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
  const { pool } = getDashboardDatabase();
  const [overviewResult, dailyResult, scansResult, selfResult] =
    await Promise.all([
      pool.query("select * from metabase.operator_overview"),
      pool.query(
        "select * from metabase.operator_daily_funnel order by day asc",
      ),
      pool.query(
        "select * from metabase.operator_recent_scans order by accepted_at desc limit 50",
      ),
      pool.query("select * from metabase.operator_self_scan limit 1"),
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
      browserStatus:
        row.browser_status === null ? null : String(row.browser_status),
    })),
    selfScan: selfResult.rows[0]
      ? {
          scanId: String(selfResult.rows[0].scan_id),
          targetHost: String(selfResult.rows[0].target_host),
          segment: String(selfResult.rows[0].segment),
          status: String(selfResult.rows[0].status),
          score: asNullableNumber(selfResult.rows[0].score),
          coverage: asNullableNumber(selfResult.rows[0].coverage),
          level:
            selfResult.rows[0].level === null
              ? null
              : String(selfResult.rows[0].level),
          acceptedAt: asIso(selfResult.rows[0].accepted_at),
          finishedAt:
            selfResult.rows[0].finished_at === null
              ? null
              : asIso(selfResult.rows[0].finished_at),
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
