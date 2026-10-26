const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether an id read from a request has the shape of a scan's. The database
 * refuses to compare anything else with a scan's id, so a route that asked
 * it would fail rather than answer that there is no such scan.
 */
export const isScanId = (id: string): boolean => SCAN_ID.test(id);
