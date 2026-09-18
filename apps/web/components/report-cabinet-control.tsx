"use client";

import React, { useEffect, useRef, useState } from "react";

import {
  type ReportCabinetHandoff,
  takeReportCabinetHandoff,
} from "../lib/client/report-cabinet-handoff";

type CabinetActionProps =
  | Readonly<{ handoff: ReportCabinetHandoff; email?: never }>
  | Readonly<{ handoff: null; email: string }>;

export function ReportCabinetAction(props: CabinetActionProps) {
  if (props.handoff) {
    return (
      <form action={props.handoff.action} method="post">
        <input name="token" type="hidden" value={props.handoff.token} />
        <button className="button button-primary" type="submit">
          Open your cabinet
        </button>
      </form>
    );
  }
  return (
    <form action="/cabinet/sign-in" method="post">
      <input name="email" type="hidden" value={props.email} />
      <input name="destination" type="hidden" value="default" />
      <button className="button button-primary" type="submit">
        Email me a cabinet link
      </button>
    </form>
  );
}

export function ReportCabinetControl({
  email,
  reportPath,
}: Readonly<{ email: string; reportPath: string }>) {
  const checked = useRef(false);
  const [handoff, setHandoff] = useState<ReportCabinetHandoff | null>();

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    setHandoff(takeReportCabinetHandoff(reportPath) ?? null);
  }, [reportPath]);

  if (handoff === undefined) {
    return <button disabled>Checking cabinet access…</button>;
  }
  return handoff ? (
    <ReportCabinetAction handoff={handoff} />
  ) : (
    <ReportCabinetAction email={email} handoff={null} />
  );
}
