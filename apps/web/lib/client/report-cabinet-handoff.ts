"use client";

type Handoff = Readonly<{ reportPath: string; actionUrl: string }>;

let handoff: Handoff | undefined;

export function clearReportCabinetHandoff() {
  handoff = undefined;
}

export function rememberReportCabinetHandoff(
  reportPath: string,
  actionUrl: string,
  expectedOrigin: string,
): boolean {
  clearReportCabinetHandoff();
  if (!/^\/report\/[0-9a-f-]+$/i.test(reportPath)) return false;
  let parsed: URL;
  try {
    parsed = new URL(actionUrl);
  } catch {
    return false;
  }
  const parameters = [...parsed.searchParams.keys()];
  if (
    parsed.origin !== expectedOrigin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/cabinet/sign-in/open" ||
    parameters.length !== 1 ||
    parameters[0] !== "token" ||
    !/^[A-Za-z0-9]{32}$/.test(parsed.searchParams.get("token") ?? "")
  ) {
    return false;
  }
  handoff = { reportPath, actionUrl: parsed.toString() };
  return true;
}

export function takeReportCabinetHandoff(
  expectedReportPath: string,
): string | undefined {
  const current = handoff;
  handoff = undefined;
  return current?.reportPath === expectedReportPath
    ? current.actionUrl
    : undefined;
}
