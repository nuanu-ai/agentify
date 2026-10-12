/**
 * The addresses the shop screen's forms post to. With script, the answer to a
 * press is drawn at the press's address, so a reload reads that address; a
 * person's read of it is sent to the shop screen, where the forms are. The
 * data React Router reads after a press, at the same address with `.data` on
 * the end, goes through.
 */

import { Outlet } from "react-router";
import { readsLeadTo } from "../answer.js";
import { WOOCOMMERCE } from "../woocommerce.js";

export const handle = WOOCOMMERCE;

export const middleware = readsLeadTo("/woocommerce");

export default function Presses() {
  return <Outlet />;
}
