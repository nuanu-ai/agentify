"use client";

import { useEffect, useRef, useState } from "react";

import { takeReportCabinetHandoff } from "../lib/client/report-cabinet-handoff";

export function ReportCabinetControl({
  email,
  reportPath,
}: Readonly<{ email: string; reportPath: string }>) {
  const checked = useRef(false);
  const [actionUrl, setActionUrl] = useState<string | null>();

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    setActionUrl(takeReportCabinetHandoff(reportPath) ?? null);
  }, [reportPath]);

  if (actionUrl === undefined) {
    return <button disabled>Checking cabinet access…</button>;
  }
  if (actionUrl) {
    return (
      <a className="button button-primary" href={actionUrl}>
        Open your cabinet
      </a>
    );
  }
  return (
    <form action="/cabinet/sign-in" method="post">
      <input name="email" type="hidden" value={email} />
      <input name="destination" type="hidden" value="default" />
      <button className="button button-primary" type="submit">
        Email me a cabinet link
      </button>
    </form>
  );
}
