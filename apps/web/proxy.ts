import { type NextRequest, NextResponse } from "next/server";

import type { PublicPagePath } from "./content/public-page-metadata";
import {
  appendVary,
  isReactServerComponentRequest,
  prefersMarkdown,
} from "./lib/accept-negotiation";
import { getPublicPageMarkdown } from "./lib/public-markdown";

const responseHeaders = {
  "Cache-Control": "public, max-age=0, s-maxage=3600",
  "Content-Language": "en-US",
  Vary: "Accept",
};

export function proxy(request: NextRequest) {
  const method = request.method.toUpperCase();
  const pathname = request.nextUrl.pathname as PublicPagePath;
  const eligibleMethod = method === "GET" || method === "HEAD";
  const rsc =
    request.nextUrl.searchParams.has("_rsc") ||
    isReactServerComponentRequest(request.headers);

  if (
    eligibleMethod &&
    !rsc &&
    prefersMarkdown(request.headers.get("accept"))
  ) {
    return new Response(
      method === "HEAD" ? null : getPublicPageMarkdown(pathname),
      {
        status: 200,
        headers: {
          ...responseHeaders,
          "Content-Type": "text/markdown; charset=utf-8",
        },
      },
    );
  }

  const response = NextResponse.next();
  if (eligibleMethod && !rsc) {
    response.headers.set("Cache-Control", responseHeaders["Cache-Control"]);
    response.headers.set(
      "Content-Language",
      responseHeaders["Content-Language"],
    );
    response.headers.set(
      "Vary",
      appendVary(response.headers.get("Vary"), "Accept"),
    );
  }
  return response;
}

export const config = {
  matcher: [
    "/owner",
    "/store",
    "/local",
    "/methodology",
    "/scanner",
    "/privacy",
    "/terms",
  ],
};
