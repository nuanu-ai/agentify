import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

/**
 * Gives the browser whose live session the request carries a new session of
 * the same person, made and set as the component makes one at sign-in, so the
 * old token can end without signing that browser out. The new session keeps
 * the old one's sign-in moment, which notices name: it carries on that
 * sign-in rather than being a new one. Reached only through `auth.api` in this
 * process, since the component's HTTP routes are not mounted.
 */
export const renewedSession = () =>
  ({
    id: "dashboard-renewed-session",
    endpoints: {
      renewSession: createAuthEndpoint(
        "/dashboard/renew-session",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session: old, user } = ctx.context.session;
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            false,
            { createdAt: old.createdAt },
            true,
          );
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ token: session.token });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
