/**
 * The form a partner network's click identifier must have to be kept at all;
 * the dashboard reads it by this pattern. Free of any schema library, and
 * exported as source because the dashboard runs this package without building
 * it.
 */
export const PARTNER_CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
