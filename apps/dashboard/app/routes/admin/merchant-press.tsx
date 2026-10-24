/**
 * What every press route on a merchant's page shares: a read of its own
 * address leads to the merchant's page, since a page drawn there without a
 * press would say nothing happened; a press is answered with that page in its
 * new state, read after the change. Not a route of its own: `merchant-admit`,
 * `merchant-withdraw` and `merchant-key-disable` are.
 */

import {
  type ActionFunctionArgs,
  Link,
  type MiddlewareFunction,
  redirectDocument,
  useActionData,
} from "react-router";
import type { MerchantIntent, MerchantView, PressedUnread } from "../../../src/admin/merchants.js";
import { acted, formOf } from "../../answer.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { MerchantScreen } from "../../screens/admin/merchants.js";
import { services, workspaceIn } from "../../services.js";

export const readsLeadToTheMerchant: MiddlewareFunction<Response>[] = [
  ({ request, url, context, params }, next) => {
    const reading = request.method === "GET" || request.method === "HEAD";
    if (reading && new URL(request.url).pathname === url.pathname) {
      throw redirectDocument(
        `${context.get(services).base}/admin/merchants/${encodeURIComponent(params.merchant_id ?? "")}`,
        303,
      );
    }
    return next();
  },
];

/** The press a route makes, from its address's parameters. */
export const pressing =
  (intentOf: (params: ActionFunctionArgs["params"]) => MerchantIntent) =>
  async (asked: ActionFunctionArgs) => {
    const { admin, operator } = workspaceIn(asked.context);
    const { params, request } = asked;
    return await acted(
      async () =>
        await admin.merchants.press(
          operator,
          params.merchant_id ?? "",
          intentOf(params),
          await formOf(request),
        ),
      asked,
    );
  };

/** The merchant's page, as the press answered it. */
export function MerchantPressed() {
  // Every press route's action is `pressing`'s, which answers with this view.
  const view = useActionData() as MerchantView | PressedUnread | undefined;
  if (view === undefined) throw new Error("a merchant's press was drawn without its answer");
  if ("unread" in view) {
    return (
      <AdminFrame section="merchants" title="The merchant's page could not be read again">
        <div className="lede">
          <div>
            <p>{view.said}</p>
            <p>
              The merchant's page could not be read again after the press. Open it to see where the
              merchant stands now.
            </p>
          </div>
        </div>
        <div className="connect-actions">
          <Link
            className="button button-primary"
            to={`/admin/merchants/${encodeURIComponent(view.merchantId)}`}
          >
            Open the merchant's page
          </Link>
        </div>
      </AdminFrame>
    );
  }
  return (
    <AdminFrame section="merchants" title={view.name}>
      <MerchantScreen view={view} />
    </AdminFrame>
  );
}
