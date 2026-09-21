import { createHmac, timingSafeEqual } from "node:crypto";

export const REPORT_CABINET_HANDOFF_COOKIE = "agentify_report_cabinet_handoff";
export const REPORT_CABINET_HANDOFF_TTL_SECONDS = 60 * 60;

const PURPOSE = "agentify-report-cabinet-handoff-v1";
const CLOCK_SKEW_SECONDS = 60;
const TOKEN = /^[A-Za-z0-9]{32}$/;
const SCAN_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Claims = Readonly<{
  v: 1;
  e: string;
  s: string;
  r: string;
  t: string;
  i: number;
  x: number;
}>;

export type ReportCabinetHandoff = Readonly<{
  email: string;
  reportPath: string;
  scanId: string;
  token: string;
}>;

function normalizeEmail(value: string): string {
  return value.trim().normalize("NFKC").toLowerCase();
}

function signature(secret: string, encodedClaims: string): Buffer {
  return createHmac("sha256", secret)
    .update(PURPOSE)
    .update("\0")
    .update(encodedClaims)
    .digest();
}

function actionToken(actionUrl: string, publicOrigin: string): string | null {
  let action: URL;
  let expectedOrigin: string;
  try {
    action = new URL(actionUrl);
    expectedOrigin = new URL(publicOrigin).origin;
  } catch {
    return null;
  }
  const parameters = [...action.searchParams.keys()];
  const token = action.searchParams.get("token") ?? "";
  return action.origin === expectedOrigin &&
    action.username === "" &&
    action.password === "" &&
    action.pathname === "/cabinet/sign-in/open" &&
    action.hash === "" &&
    parameters.length === 1 &&
    parameters[0] === "token" &&
    TOKEN.test(token)
    ? token
    : null;
}

export function sealReportCabinetHandoff(input: {
  actionUrl: string;
  email: string;
  now: Date;
  publicOrigin: string;
  scanId: string;
  secret: string;
}): string | null {
  const token = actionToken(input.actionUrl, input.publicOrigin);
  if (!token || !SCAN_ID.test(input.scanId) || input.secret.length < 32) {
    return null;
  }
  const email = normalizeEmail(input.email);
  if (email.length === 0 || email.length > 320) return null;
  const issuedAt = Math.floor(input.now.getTime() / 1_000);
  const reportPath = `/report/${input.scanId}`;
  const claims: Claims = {
    v: 1,
    e: email,
    s: input.scanId,
    r: reportPath,
    t: token,
    i: issuedAt,
    x: issuedAt + REPORT_CABINET_HANDOFF_TTL_SECONDS,
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString(
    "base64url",
  );
  return `v1.${encodedClaims}.${signature(input.secret, encodedClaims).toString("base64url")}`;
}

export function openReportCabinetHandoff(
  sealed: string,
  expected: {
    email: string;
    now: Date;
    reportPath: string;
    secret: string;
  },
): ReportCabinetHandoff | null {
  if (sealed.length > 2_048) return null;
  const [version, encodedClaims, encodedSignature, extra] = sealed.split(".");
  if (
    version !== "v1" ||
    !encodedClaims ||
    !encodedSignature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(encodedClaims) ||
    !/^[A-Za-z0-9_-]{43}$/.test(encodedSignature) ||
    expected.secret.length < 32
  ) {
    return null;
  }
  const supplied = Buffer.from(encodedSignature, "base64url");
  const wanted = signature(expected.secret, encodedClaims);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return null;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(
      Buffer.from(encodedClaims, "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const value = claims as Partial<Claims>;
  if (
    Object.keys(value).sort().join(",") !== "e,i,r,s,t,v,x" ||
    value.v !== 1 ||
    typeof value.e !== "string" ||
    typeof value.s !== "string" ||
    typeof value.r !== "string" ||
    typeof value.t !== "string" ||
    typeof value.i !== "number" ||
    typeof value.x !== "number" ||
    !Number.isInteger(value.i) ||
    !Number.isInteger(value.x) ||
    !SCAN_ID.test(value.s) ||
    !TOKEN.test(value.t) ||
    value.r !== `/report/${value.s}` ||
    value.e !== normalizeEmail(expected.email) ||
    value.r !== expected.reportPath ||
    value.x - value.i !== REPORT_CABINET_HANDOFF_TTL_SECONDS
  ) {
    return null;
  }
  const now = Math.floor(expected.now.getTime() / 1_000);
  if (value.i > now + CLOCK_SKEW_SECONDS || value.x <= now) return null;
  return {
    email: value.e,
    reportPath: value.r,
    scanId: value.s,
    token: value.t,
  };
}
