/**
 * The visual frame shared by the cabinet's two transactional messages.
 *
 * Email clients disagree about stylesheets and fonts, so the layout is a
 * presentation table with inline styles and a system-font stack. The wordmark
 * is text and the action remains a visible link: neither depends on an image,
 * a downloaded font or CSS arriving from somewhere else.
 */

export interface TransactionalEmail {
  readonly preview: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly lead: string;
  readonly action: string;
  readonly link: string;
  readonly paragraphs: readonly string[];
}

/** Escape untrusted text before placing it in HTML text or an attribute. */
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );

export function transactionalEmailHtml(message: TransactionalEmail): string {
  const preview = escapeHtml(message.preview);
  const eyebrow = escapeHtml(message.eyebrow);
  const title = escapeHtml(message.title);
  const lead = escapeHtml(message.lead);
  const action = escapeHtml(message.action);
  const link = escapeHtml(message.link);
  const paragraphs = message.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:#6B6862;font-size:15px;line-height:1.65;">${escapeHtml(paragraph)}</p>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#F6F4EF;color:#1A1917;font-family:'Schibsted Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preview}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#F6F4EF;">
    <tr>
      <td align="center" style="padding:36px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:0 4px 20px;color:#1A1917;font-size:22px;font-weight:700;letter-spacing:-0.4px;">Agentify</td>
          </tr>
          <tr>
            <td style="background:#FFFFFF;border:1px solid #E7E3DB;border-radius:16px;padding:40px 36px;">
              <p style="margin:0 0 12px;color:#0F736E;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">${eyebrow}</p>
              <h1 style="margin:0 0 16px;color:#1A1917;font-size:30px;line-height:1.2;font-weight:650;letter-spacing:-0.7px;">${title}</h1>
              <p style="margin:0 0 28px;color:#1A1917;font-size:17px;line-height:1.6;">${lead}</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;">
                <tr>
                  <td style="background:#0F736E;border-radius:12px;">
                    <a href="${link}" style="display:inline-block;padding:14px 22px;color:#FFFFFF;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;">${action}</a>
                  </td>
                </tr>
              </table>
              ${paragraphs}
              <p style="margin:24px 0 8px;color:#6B6862;font-size:13px;line-height:1.55;">If the button does not work, copy this link into your browser:</p>
              <p style="margin:0;padding:12px 14px;background:#F6F4EF;border:1px solid #E7E3DB;border-radius:8px;color:#0F736E;font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:12px;line-height:1.55;word-break:break-all;"><a href="${link}" style="color:#0F736E;text-decoration:underline;">${link}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px 0;color:#6B6862;font-size:12px;line-height:1.5;">Agentify secure access message</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
