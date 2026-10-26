/**
 * The dashboard's sign-in, as the scanner's doors open it for a person who
 * signs in to read their reports. The destination tells the dashboard so, and
 * such a sign-in makes no merchant; the dashboard's own doors open the sign-in
 * without it, and a sign-in there opens a seller dashboard.
 */
export const READING_SIGN_IN = "/dashboard/sign-in?destination=reports";
