import React from "react";

export function ReportCabinetAction({
  email,
  reportPath,
}: Readonly<{ email: string; reportPath: string }>) {
  return (
    <form action="/cabinet/report-handoff" method="post">
      <input name="email" type="hidden" value={email} />
      <input name="report_path" type="hidden" value={reportPath} />
      <button className="button button-primary" type="submit">
        Open your cabinet
      </button>
    </form>
  );
}

export function ReportCabinetControl({
  email,
  reportPath,
}: Readonly<{ email: string; reportPath: string }>) {
  return <ReportCabinetAction email={email} reportPath={reportPath} />;
}
