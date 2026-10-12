/**
 * The address a page was drawn for, carried by every form behind the gate. A
 * tab drawn for one address is often still open when another signs in, and the
 * browser then sends the new cookie with the old form, so the cookie alone
 * cannot say whose page was pressed; the gate refuses a form drawn for somebody
 * else, and one drawn for nobody.
 *
 * A module of its own with nothing imported, because the React pages put it on
 * their forms in the browser too.
 */
export const DRAWN_FOR = "signed_in_as";
