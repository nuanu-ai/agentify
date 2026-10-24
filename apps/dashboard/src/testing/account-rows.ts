/**
 * Who holds the operator flag, written straight into an in-memory identity's
 * rows, for a test whose subject is not the press that changes it: that press
 * mails every operator and keeps the last one's flag, which such a test does
 * not want in its way.
 */

export const flagRow = (
  rows: Record<string, Record<string, unknown>[]>,
  email: string,
  operator: boolean,
): void => {
  const row = (rows.dashboard_accounts ?? []).find(
    (account) => account.email === email.trim().toLowerCase(),
  );
  if (row === undefined) throw new Error(`no account row has the address ${email}`);
  row.operator = operator;
};
