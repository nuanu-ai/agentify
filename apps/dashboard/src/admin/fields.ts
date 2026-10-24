/**
 * The names an action form's fields carry, shared by the form that draws them
 * and the press that reads them. It imports nothing, so a screen can import it
 * without carrying any of the server into the browser's build.
 */

/** The box that names the consequence, and the value it carries when ticked. */
export const CONFIRM_FIELD = "confirm";
export const CONFIRMED = "yes";

/** The box the operator writes their reason in. */
export const REASON_FIELD = "reason";

/** The field a Check now press names its check in. */
export const CHECK_FIELD = "check";
