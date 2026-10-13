export function markdownDownloadResponse(content: string, filename: string): Response {
  const safeFilename = filename.replace(/[^a-z0-9._-]+/gi, "-");
  return new Response(content, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "text/markdown; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
