import { buildLlmsText } from "../../lib/llms";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(buildLlmsText(), {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
