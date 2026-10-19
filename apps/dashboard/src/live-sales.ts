/**
 * Live approval is an administrative decision, never a merchant-key operation.
 * The account flag is read again for every request, including a repeated grant.
 */
import { type Gateway, grantLiveApproval } from "@agentify/gateway";
import type { ApprovalDirectory } from "./approval-command.js";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity } from "./dashboard-entry.js";
import { noted } from "./noted.js";
import type { Outcome } from "./page-services.js";
import { type MomentView, momentView } from "./views.js";

interface LiveSalesMerchant {
  readonly email: string;
  readonly id: string;
  readonly name: string | null;
  readonly site: string | null;
  readonly integration: string;
  readonly approvedAt: MomentView | null;
}

export interface LiveSalesView {
  readonly live: boolean;
  readonly email: string;
  readonly merchant: LiveSalesMerchant | null;
  readonly message: string | null;
}

export interface LiveSalesPages {
  page(cookie: string | undefined): Promise<Outcome<LiveSalesView>>;
  press(cookie: string | undefined, form: FormData): Promise<Outcome<LiveSalesView>>;
}

const one = (form: FormData, name: string): string => {
  const values = form.getAll(name);
  return values.length === 1 && typeof values[0] === "string" ? values[0].trim() : "";
};

export function liveSalesFor(
  config: DashboardConfig,
  parts: {
    readonly identity: DashboardIdentity;
    readonly directory: ApprovalDirectory;
    readonly gateway: Gateway;
  },
): LiveSalesPages {
  const { store, clock } = parts.gateway.runtime;
  const live = config.surfaceMode === "live" && parts.gateway.runtime.config.surfaceMode === "live";
  const authorized = async (cookie: string | undefined) => {
    try {
      const session = await parts.identity.whoIs(cookie, { renew: false });
      return session?.operator === true ? session.person : null;
    } catch {
      return null;
    }
  };
  const missing: Outcome<LiveSalesView> = {
    kind: "problem",
    problem: { status: 404, said: "There is no such page." },
  };
  const view = (
    email = "",
    message: string | null = null,
    status = 200,
    merchant: LiveSalesMerchant | null = null,
  ): Outcome<LiveSalesView> => ({ kind: "view", view: { live, email, merchant, message }, status });

  return {
    async page(cookie) {
      return (await authorized(cookie)) === null ? missing : view();
    },
    async press(cookie, form) {
      const administrator = await authorized(cookie);
      if (administrator === null) return missing;
      if (!live)
        return view(
          "",
          "Test sales need no approval. Open the live site's admin screen to approve real sales.",
          409,
        );
      const email = one(form, "email").toLowerCase();
      const intent = one(form, "intent");
      if (email === "") return view("", "Enter the seller's account email.", 400);
      if (intent !== "lookup" && intent !== "approve")
        return view(email, "Choose Find merchant or confirm live sales.", 400);
      if (
        intent === "approve" &&
        (one(form, "merchant_id") === "" || one(form, "confirm") !== "live-sales")
      ) {
        return view(email, "Find the merchant and confirm that they may sell for real money.", 400);
      }

      let merchant: LiveSalesMerchant;
      try {
        const matches = await parts.directory.resolve(email);
        if (matches.length !== 1)
          return view(
            email,
            matches.length === 0
              ? "No account matches that email. Check the address with the seller."
              : "More than one account matches that email. No approval was granted.",
            409,
          );
        const match = matches[0];
        if (match?.binding !== "bound")
          return view(email, "This account has not registered as a merchant yet.", 409);
        if (intent === "approve" && one(form, "merchant_id") !== match.merchantId) {
          return view(
            email,
            "The account does not match the merchant you confirmed. Find the merchant again.",
            409,
          );
        }
        const found = await store.merchantById(match.merchantId);
        if (found === null)
          return view(
            email,
            "The account's merchant could not be found. No approval was granted.",
            409,
          );
        merchant = {
          email: match.email,
          id: found.id,
          name: found.serviceName,
          site: found.sellerSite,
          integration: found.integration,
          approvedAt:
            found.liveApprovedAt === null
              ? null
              : momentView(new Date(found.liveApprovedAt).toISOString()),
        };
      } catch {
        return view(
          email,
          "The account or merchant could not be read. No approval was requested. Try again.",
          503,
        );
      }
      if (intent === "lookup") return view(email, null, 200, merchant);
      try {
        const granted = await grantLiveApproval(store, merchant.id, clock());
        if (granted === null)
          return view(email, "The merchant no longer exists. No approval was granted.", 409);
        if (granted.merchant.liveApprovedAt === null) throw new Error("approval was not recorded");
        noted(
          administrator,
          `${granted.changed ? "approved" : "confirmed existing approval for"} live sales for merchant ${merchant.id}`,
        );
        return view(
          email,
          granted.changed
            ? "Live sales approved."
            : "This merchant is already approved for live sales.",
          200,
          {
            ...merchant,
            approvedAt: momentView(new Date(granted.merchant.liveApprovedAt).toISOString()),
          },
        );
      } catch {
        return view(
          email,
          "The approval outcome is unknown. Find this merchant again to read the current status; repeating the approval is safe.",
          503,
        );
      }
    },
  };
}
