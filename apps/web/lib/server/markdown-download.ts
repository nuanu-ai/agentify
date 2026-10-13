/**
 * A Markdown file the browser saves rather than shows. `nosniff` is not written
 * here: the process writes it on every answer, and written here as well it
 * would be sent twice.
 */
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
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
